import config from './config';
import type { WiimDevice } from './types';

interface ParsedLocation {
  readonly protocol: string;
  readonly host: string;
  readonly path: string;
}

interface ServiceDefinition {
  readonly controlUrl: string;
  readonly eventUrl: string | null;
}

export interface ParsedEvent {
  readonly deviceId: string | null;
  readonly volume: number | null;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const normalizeVolume = (volume: number): number =>
  Math.round(clamp(volume, 0, 1) * 100);

export const denormalizeVolume = (volume: number): number =>
  clamp(volume, 0, 100) / 100;

export const toTimeoutHeader = (seconds: number): string =>
  `Second-${seconds}`;

export const getHeaderValue = (
  headers: Readonly<Record<string, string>> | null | undefined,
  targetName: string,
): string | undefined => {
  if (!headers) {
    return undefined;
  }

  const normalizedName = targetName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
};

export const createSoapBody = (
  serviceType: string,
  action: string,
  properties: Readonly<Record<string, string | number>> = {},
): string => {
  const payload = Object.entries(properties)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join('');

  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">${payload}</u:${action}>
  </s:Body>
</s:Envelope>`;
};

const extractXmlTagValue = (xml: string, tagName: string): string | null => {
  const match = xml.match(
    new RegExp(`<${tagName}[^>]*>([^<]*)<\/${tagName}>`, 'i'),
  );
  return match ? match[1].trim() : null;
};

export const splitLocation = (location: string): ParsedLocation | null => {
  const match = location.match(/^(https?):\/\/([^\/?#]+)([^?#]*)?.*/i);
  return match
    ? { protocol: match[1].toLowerCase(), host: match[2], path: match[3] || '/' }
    : null;
};

export const resolveUrl = (
  baseLocation: string,
  relativeUrl: string | null,
): string | null => {
  if (!relativeUrl) {
    return null;
  }
  if (/^https?:\/\//i.test(relativeUrl)) {
    return relativeUrl;
  }

  const base = splitLocation(baseLocation);
  if (!base) {
    return null;
  }
  if (relativeUrl.startsWith('/')) {
    return `${base.protocol}://${base.host}${relativeUrl}`;
  }

  const baseDirectory = base.path.replace(/[^/]*$/, '') || '/';
  return `${base.protocol}://${base.host}${baseDirectory}${relativeUrl}`;
};

const extractService = (
  xml: string,
  serviceType: string,
): ServiceDefinition | null => {
  const servicePattern = /<service>([\s\S]*?)<\/service>/gi;
  let match: RegExpExecArray | null;

  while ((match = servicePattern.exec(xml)) !== null) {
    const service = match[1];
    if (!service.includes(serviceType)) {
      continue;
    }

    const controlUrl = extractXmlTagValue(service, 'controlURL');
    const eventUrl = extractXmlTagValue(service, 'eventSubURL');
    if (controlUrl) {
      return { controlUrl, eventUrl };
    }
  }

  return null;
};

export const parseDeviceDescription = (
  xml: string,
  location: string,
): WiimDevice | null => {
  if (!xml || !location) {
    return null;
  }

  const name = extractXmlTagValue(xml, 'friendlyName');
  const model = extractXmlTagValue(xml, 'modelName');
  const renderingControl = extractService(xml, config.renderingControlService);
  const avTransport = extractService(xml, config.avTransportService);
  const parsedLocation = splitLocation(location);
  const renderingControlUrl = renderingControl
    ? resolveUrl(location, renderingControl.controlUrl)
    : null;
  const renderingEventUrl = renderingControl
    ? resolveUrl(location, renderingControl.eventUrl)
    : null;
  const avTransportControlUrl = avTransport
    ? resolveUrl(location, avTransport.controlUrl)
    : null;

  if (
    !name ||
    !model ||
    !parsedLocation ||
    !renderingControlUrl ||
    !renderingEventUrl ||
    !avTransportControlUrl
  ) {
    return null;
  }

  return {
    name,
    model,
    location,
    baseUrl: `${parsedLocation.protocol}://${parsedLocation.host}`,
    renderingControlUrl,
    renderingEventUrl,
    avTransportControlUrl,
    usn: extractXmlTagValue(xml, 'UDN'),
  };
};

export const replaceLocationHost = (
  location: string,
  host: string,
): string | null => {
  const match = location.match(
    /^(https?:\/\/)(?:\[[^\]]+\]|[^/:]+)(:\d+)?(\/.*)$/i,
  );
  return match ? `${match[1]}${host}${match[2] || ''}${match[3]}` : null;
};

export const parseSsdpHeaders = (payload: string): Record<string, string> =>
  payload
    .split(/\r?\n/)
    .slice(1)
    .reduce<Record<string, string>>((headers, line) => {
      const separator = line.indexOf(':');
      if (separator !== -1) {
        const name = line.slice(0, separator).trim().toLowerCase();
        if (name) {
          headers[name] = line.slice(separator + 1).trim();
        }
      }
      return headers;
    }, {});

export const parseEvent = (payload: string): ParsedEvent => {
  if (!payload) {
    return { deviceId: null, volume: null };
  }

  const deviceMatch = payload.match(/NOTIFY \/(\S+)/);
  const volumeMatch =
    payload.match(
      /\bVolume\b(?:\s+[A-Za-z_:][\w:.-]*="[^"]*")*\s+val="(\d+)"/,
    ) || payload.match(/\bSlaveVolume="(\d+)"/);

  return {
    deviceId: deviceMatch ? decodeURI(deviceMatch[1]) : null,
    volume: volumeMatch ? Number(volumeMatch[1]) : null,
  };
};
