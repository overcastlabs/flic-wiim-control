import dgram = require('dgram');
import config from './config';
import { request, rawRequest } from './http-client';
import { logger } from './logger';
import {
  parseDeviceDescription,
  parseSsdpHeaders,
  replaceLocationHost,
  splitLocation,
} from './upnp-protocol';
import type { DeviceMap, WiimDevice } from './types';

const discoveryTimeoutMs = config.ssdp.maximumWaitSeconds * 1000 + 250;

const createSearchMessage = (searchTarget: string): Buffer =>
  Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${config.ssdp.address}:${config.ssdp.port}`,
      'MAN: "ssdp:discover"',
      `MX: ${config.ssdp.maximumWaitSeconds}`,
      `ST: ${searchTarget}`,
      '',
      '',
    ].join('\r\n'),
  );

const isMediaRenderer = (searchTarget?: string): boolean => {
  const normalized = searchTarget?.toLowerCase();
  return Boolean(
    normalized &&
      (normalized.includes('mediarenderer') || normalized.includes('rootdevice')),
  );
};

const fetchDescription = async (location: string): Promise<WiimDevice | null> => {
  try {
    const response = await request({ url: location, method: 'GET' });
    return parseDeviceDescription(response.content, location);
  } catch (error) {
    logger.error(`Failed to fetch device description from ${location}`, error);
    return null;
  }
};

interface DiscoveryOptions {
  readonly devices: DeviceMap;
  readonly onDeviceDiscovered?: (device: WiimDevice) => void;
}

interface GroupedDevice {
  readonly ip?: string;
  readonly name?: string;
}

interface GroupTopology {
  readonly slave_list?: GroupedDevice[];
}

export const createDiscovery = ({
  devices,
  onDeviceDiscovered,
}: DiscoveryOptions) => {
  const register = (device: WiimDevice | null): boolean => {
    if (!device) {
      return false;
    }
    if (!device.model.toLowerCase().includes('wiim')) {
      logger.debug(`Ignoring non-WiiM device: ${device.name} (${device.model})`);
      return false;
    }
    if (devices.has(device.name)) {
      return false;
    }

    devices.set(device.name, device);
    logger.info(`Discovered WiiM device: ${device.name} (${device.baseUrl})`);
    onDeviceDiscovered?.(device);
    return true;
  };

  const fetchGroupedDevices = async (master: WiimDevice): Promise<void> => {
    const location = splitLocation(master.location);
    if (!location) {
      return;
    }

    const host = location.host.replace(/:\d+$/, '');
    try {
      const response = await rawRequest({
        url: `https://${host}${config.slaveListPath}`,
        method: 'GET',
        rejectUnauthorized: false,
        timeoutMs: 10000,
      });
      const topology = JSON.parse(response.content) as GroupTopology;
      const slaves = Array.isArray(topology.slave_list)
        ? topology.slave_list
        : [];

      for (const slave of slaves) {
        if (!slave.ip) {
          continue;
        }

        const slaveLocation = replaceLocationHost(master.location, slave.ip);
        if (!slaveLocation) {
          logger.error(
            `Unable to construct UPnP location for ${slave.name || slave.ip}`,
          );
          continue;
        }
        register(await fetchDescription(slaveLocation));
      }
    } catch (error) {
      logger.error(`Failed to discover grouped devices for ${master.name}`, error);
    }
  };

  const discoverGroups = async (): Promise<void> => {
    const visibleDevices = Array.from(devices.values());
    for (const master of visibleDevices) {
      await fetchGroupedDevices(master);
    }
  };

  const sendSearches = (socket: dgram.Socket, label: string): void => {
    config.ssdp.searchTargets.forEach((target) => {
      logger.debug(`Sending ${label} SSDP search for ${target}`);
      const message = createSearchMessage(target);
      socket.send(
        message,
        0,
        message.length,
        config.ssdp.port,
        config.ssdp.address,
      );
    });
  };

  const discover = (timeoutMs = discoveryTimeoutMs): Promise<DeviceMap> => {
    logger.info(`Starting WiiM SSDP discovery (timeout ${timeoutMs}ms)`);
    devices.clear();

    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const locations = new Set<string>();
      const pendingDescriptions = new Set<Promise<boolean>>();
      let finalized = false;

      const finalize = (): void => {
        if (finalized) {
          return;
        }
        finalized = true;

        try {
          socket.close();
        } catch (error) {
          logger.debug('Error closing SSDP socket', error);
        }

        Promise.all(Array.from(pendingDescriptions))
          .then(discoverGroups)
          .catch((error: unknown) => logger.error('WiiM discovery failed', error))
          .finally(() => {
            logger.info(`WiiM discovery complete (found ${devices.size})`);
            resolve(devices);
          });
      };

      socket.on('message', (message) => {
        const headers = parseSsdpHeaders(message.toString());
        if (!isMediaRenderer(headers.st || headers.nt)) {
          return;
        }

        const location = headers.location;
        if (!location || locations.has(location)) {
          return;
        }
        locations.add(location);

        const pending = fetchDescription(location).then(register);
        pendingDescriptions.add(pending);
        void pending.finally(() => pendingDescriptions.delete(pending));
      });

      socket.on('error', (error) => {
        logger.error('SSDP discovery socket error', error);
        finalize();
      });

      socket.on('listening', () => {
        sendSearches(socket, 'initial');
        setTimeout(() => {
          if (!finalized) {
            sendSearches(socket, 'retry');
          }
        }, config.ssdp.retryDelayMs);
      });

      // Responses return to the sender's source port. An ephemeral port also
      // avoids competing with the hub's own SSDP service on port 1900.
      socket.bind(0);
      setTimeout(finalize, timeoutMs);
    });
  };

  return { discover };
};
