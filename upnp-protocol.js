'use strict';

const { renderingControlService } = require('./config');

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, value));

const normalizeVolume = (volume) => Math.round(clamp(volume, 0, 1) * 100);
const denormalizeVolume = (volume) => clamp(volume, 0, 100) / 100;
const toTimeoutHeader = (seconds) => `Second-${seconds}`;

const getHeaderValue = (headers, targetName) => {
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

const createSoapBody = (action, properties = {}) => {
  const payload = Object.entries(properties)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join('');

  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${renderingControlService}">${payload}</u:${action}>
  </s:Body>
</s:Envelope>`;
};

const extractXmlTagValue = (xml, tagName) => {
  const match = xml.match(
    new RegExp(`<${tagName}[^>]*>([^<]*)<\/${tagName}>`, 'i'),
  );
  return match ? match[1].trim() : null;
};

const splitLocation = (location) => {
  const match = location?.match(/^(https?):\/\/([^\/?#]+)([^?#]*)?.*/i);
  return match
    ? { protocol: match[1].toLowerCase(), host: match[2], path: match[3] || '/' }
    : null;
};

const resolveUrl = (baseLocation, relativeUrl) => {
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

const extractRenderingControlService = (xml) => {
  const servicePattern = /<service>([\s\S]*?)<\/service>/gi;
  let match;

  while ((match = servicePattern.exec(xml)) !== null) {
    const service = match[1];
    if (!service.includes(renderingControlService)) {
      continue;
    }

    const controlUrl = extractXmlTagValue(service, 'controlURL');
    const eventUrl = extractXmlTagValue(service, 'eventSubURL');
    if (controlUrl && eventUrl) {
      return { controlUrl, eventUrl };
    }
  }

  return null;
};

const parseDeviceDescription = (xml, location) => {
  if (!xml || !location) {
    return null;
  }

  const name = extractXmlTagValue(xml, 'friendlyName');
  const model = extractXmlTagValue(xml, 'modelName');
  const service = extractRenderingControlService(xml);
  const parsedLocation = splitLocation(location);
  if (!name || !model || !service || !parsedLocation) {
    return null;
  }

  return {
    name,
    model,
    location,
    baseUrl: `${parsedLocation.protocol}://${parsedLocation.host}`,
    controlUrl: resolveUrl(location, service.controlUrl),
    eventUrl: resolveUrl(location, service.eventUrl),
    usn: extractXmlTagValue(xml, 'UDN'),
  };
};

const replaceLocationHost = (location, host) => {
  const match = location.match(
    /^(https?:\/\/)(?:\[[^\]]+\]|[^/:]+)(:\d+)?(\/.*)$/i,
  );
  return match ? `${match[1]}${host}${match[2] || ''}${match[3]}` : null;
};

const parseSsdpHeaders = (payload) =>
  payload
    .split(/\r?\n/)
    .slice(1)
    .reduce((headers, line) => {
      const separator = line.indexOf(':');
      if (separator !== -1) {
        const name = line.slice(0, separator).trim().toLowerCase();
        if (name) {
          headers[name] = line.slice(separator + 1).trim();
        }
      }
      return headers;
    }, {});

const parseEvent = (payload) => {
  if (!payload) {
    return {};
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

module.exports = {
  createSoapBody,
  denormalizeVolume,
  getHeaderValue,
  normalizeVolume,
  parseDeviceDescription,
  parseEvent,
  parseSsdpHeaders,
  replaceLocationHost,
  resolveUrl,
  splitLocation,
  toTimeoutHeader,
};
