import config from './config';
import { rawRequest, request } from './http-client';
import { logger } from './logger';
import { createSoapBody, splitLocation } from './upnp-protocol';
import type {
  DeviceMap,
  HttpResponse,
  TransportCommand,
  WiimDevice,
} from './types';

interface TransportAction {
  readonly action: string;
  readonly properties: Readonly<Record<string, string | number>>;
}

const TRANSPORT_ACTIONS = {
  play: {
    action: 'Play',
    properties: { InstanceID: 0, Speed: 1 },
  },
  pause: { action: 'Pause', properties: { InstanceID: 0 } },
  stop: { action: 'Stop', properties: { InstanceID: 0 } },
  next: { action: 'Next', properties: { InstanceID: 0 } },
  previous: {
    action: 'Previous',
    properties: { InstanceID: 0 },
  },
} as const satisfies Readonly<Record<TransportCommand, TransportAction>>;

interface ControllerOptions {
  readonly devices: DeviceMap;
}

export interface Controller {
  readonly playPreset: (deviceId: string, preset: number) => Promise<void>;
  readonly sendTransportCommand: (
    deviceId: string,
    command: TransportCommand,
  ) => Promise<void>;
  readonly setVolume: (deviceId: string, volume: number) => Promise<void>;
}

export const createController = ({ devices }: ControllerOptions): Controller => {
  const performAction = (
    deviceId: string,
    serviceType: string,
    controlUrl: (device: WiimDevice) => string,
    action: string,
    properties: Readonly<Record<string, string | number>>,
  ): Promise<HttpResponse> => {
    const device = devices.get(deviceId);
    if (!device) {
      return Promise.reject(new Error(`Unknown virtual device: ${deviceId}`));
    }

    return request({
      url: controlUrl(device),
      method: 'POST',
      headers: {
        SOAPACTION: `"${serviceType}#${action}"`,
        'CONTENT-TYPE': 'text/xml; charset="utf-8"',
      },
      content: createSoapBody(serviceType, action, properties),
    });
  };

  const setVolume = async (deviceId: string, volume: number): Promise<void> => {
    try {
      await performAction(
        deviceId,
        config.renderingControlService,
        (device) => device.renderingControlUrl,
        'SetVolume',
        {
          InstanceID: 0,
          Channel: 'Single',
          DesiredVolume: volume,
        },
      );
    } catch (error) {
      logger.error(`Unable to set volume for ${deviceId}`, error);
    }
  };

  const sendTransportCommand = async (
    deviceId: string,
    command: TransportCommand,
  ): Promise<void> => {
    const definition = TRANSPORT_ACTIONS[command];
    if (!definition) {
      throw new Error(`Unsupported transport command: ${command}`);
    }

    try {
      await performAction(
        deviceId,
        config.avTransportService,
        (device) => device.avTransportControlUrl,
        definition.action,
        definition.properties,
      );
    } catch (error) {
      logger.error(`Unable to send ${command} to ${deviceId}`, error);
    }
  };

  const playPreset = async (deviceId: string, preset: number): Promise<void> => {
    if (
      !Number.isInteger(preset) ||
      preset < config.preset.minimum ||
      preset > config.preset.maximum
    ) {
      throw new Error(
        `Preset must be between ${config.preset.minimum} and ${config.preset.maximum}`,
      );
    }

    const device = devices.get(deviceId);
    const location = device ? splitLocation(device.location) : null;
    if (!device || !location) {
      throw new Error(`Unknown virtual device: ${deviceId}`);
    }

    const host = location.host.replace(/:\d+$/, '');
    try {
      await rawRequest({
        url: `https://${host}/httpapi.asp?command=MCUKeyShortClick:${preset}`,
        method: 'GET',
        rejectUnauthorized: false,
        timeoutMs: 10000,
      });
    } catch (error) {
      logger.error(`Unable to play preset ${preset} on ${deviceId}`, error);
    }
  };

  return { playPreset, sendTransportCommand, setVolume };
};
