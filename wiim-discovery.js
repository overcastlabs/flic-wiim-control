'use strict';

const dgram = require('dgram');
const config = require('./config');
const { request, rawRequest } = require('./http-client');
const logger = require('./logger');
const {
  parseDeviceDescription,
  parseSsdpHeaders,
  replaceLocationHost,
  splitLocation,
} = require('./upnp-protocol');

const discoveryTimeoutMs =
  config.ssdp.maximumWaitSeconds * 1000 + 250;

const createSearchMessage = (searchTarget) =>
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

const isMediaRenderer = (searchTarget) => {
  const normalized = searchTarget?.toLowerCase();
  return Boolean(
    normalized &&
      (normalized.includes('mediarenderer') || normalized.includes('rootdevice')),
  );
};

const fetchDescription = async (location) => {
  try {
    const response = await request({ url: location, method: 'GET' });
    return parseDeviceDescription(response.content, location);
  } catch (error) {
    logger.error(`Failed to fetch device description from ${location}`, error);
    return null;
  }
};

const createDiscovery = ({ devices, onDeviceDiscovered }) => {
  const register = (device) => {
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
    if (onDeviceDiscovered) {
      onDeviceDiscovered(device);
    }
    return true;
  };

  const fetchGroupedDevices = async (master) => {
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
      const topology = JSON.parse(response.content);
      const slaves = Array.isArray(topology.slave_list)
        ? topology.slave_list
        : [];

      for (const slave of slaves) {
        if (!slave.ip) {
          continue;
        }

        const slaveLocation = replaceLocationHost(master.location, slave.ip);
        if (!slaveLocation) {
          logger.error(`Unable to construct UPnP location for ${slave.name}`);
          continue;
        }
        register(await fetchDescription(slaveLocation));
      }
    } catch (error) {
      logger.error(`Failed to discover grouped devices for ${master.name}`, error);
    }
  };

  const discoverGroups = async () => {
    const visibleDevices = Array.from(devices.values());
    for (const master of visibleDevices) {
      await fetchGroupedDevices(master);
    }
  };

  const sendSearches = (socket, label) => {
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

  const discover = (timeoutMs = discoveryTimeoutMs) => {
    logger.info(`Starting WiiM SSDP discovery (timeout ${timeoutMs}ms)`);
    devices.clear();

    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const locations = new Set();
      const pendingDescriptions = new Set();
      let finalized = false;

      const finalize = () => {
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
          .catch((error) => logger.error('WiiM discovery failed', error))
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
        pending.finally(() => pendingDescriptions.delete(pending));
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

module.exports = { createDiscovery };
