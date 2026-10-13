'use strict';

// So Close! Wiims don't respond to SSDP discovery when linked to other Wiims

const flicapp = require('flicapp');
const dgram = require('dgram');
const http = require('http');
const net = require('net');
const network = require('network');
const rawHttp = require('./raw-http');

// -----------------
// Configuration
// -----------------
const DEBUG = false;

// -----------------
// Constants
// -----------------
const SEPARATOR = '-------------';
const CALLBACK_PORT = 44445;
const SUBSCRIPTION_TIMEOUT_SECONDS = 10 * 60; // 10min
const SUBSCRIPTION_RENEWAL_MARGIN_SECONDS = 60;
const SUBSCRIPTION_RENEWAL_STAGGER_SECONDS = 30;
const SUBSCRIPTION_RETRY_DELAY_MS = 5000;
const SUBSCRIPTION_MAX_RETRIES = 5;
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;
const SSDP_MULTICAST_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_DISCOVERY_MX = 3; // SSDP device response jitter in seconds
const SSDP_DISCOVERY_TIMEOUT_MS = SSDP_DISCOVERY_MX * 1000 + 250;
const WIIM_DEVICE_SERVICE_TYPE = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const SSDP_SEARCH_TARGETS = ['upnp:rootdevice', WIIM_DEVICE_SERVICE_TYPE];
const UPNP_MEDIA_RENDERER_SERVICE_SCHEMA = 'urn:schemas-upnp-org:service:RenderingControl:1';
const WIIM_SLAVE_LIST_PATH = '/httpapi.asp?command=multiroom:getSlaveList';

const logger = {
  info: (...args) => console.log(`INFO: ${args.shift()}`, ...args),
  error: (...args) => console.log(`ERROR: ${args.shift()}`, ...args),
  debug: (...args) => {
    if (DEBUG) {
      console.log(`DEBUG: ${args.shift()}`, ...args);
    }
  },
};

const getHubAddress = () => {
  const state = network.getState();
  const ethernet = state?.dhcp?.ethernet;
  const wifi = state?.dhcp?.wifi;

  if (ethernet?.connected && ethernet.ip) {
    return ethernet.ip;
  }
  if (wifi?.connected && wifi.ip) {
    return wifi.ip;
  }

  return null;
};

// -----------------
// Utils
// -----------------
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeVolume = (volume) => Math.round(clamp(volume, 0, 1) * 100);

const denormalizeVolume = (volume) => clamp(volume, 0, 100) / 100;

const throttle = (fn, delay = 125) => {
  let timer = null;
  return (...args) => {
    if (timer !== null) {
      return;
    }

    fn(...args);
    timer = setTimeout(() => {
      timer = null;
    }, delay);
  };
};

const createSoapEnvelope = (xml) => `
  <?xml version="1.0"?>
  <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <s:Body>${xml}</s:Body>
  </s:Envelope>
`;

const createSoapBody = (action, props = {}) => {
  const payload = Object.entries(props)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('');

  return createSoapEnvelope(`
    <u:${action} xmlns:u="${UPNP_MEDIA_RENDERER_SERVICE_SCHEMA}">
      ${payload}
    </u:${action}>
  `);
};

const toTimeoutHeader = (seconds) => `Second-${seconds}`;

const getHeaderValue = (headers, targetKey) => {
  if (!headers) {
    return undefined;
  }

  const normalizedKey = targetKey.toLowerCase();

  return Object.entries(headers).reduce((value, [key, headerValue]) => {
    if (value !== undefined) {
      return value;
    }

    return key.toLowerCase() === normalizedKey ? headerValue : undefined;
  }, undefined);
};

const httpCall = async (options) => {
  logger.debug('httpCall Options:', JSON.stringify(options, null, '\t'));

  return new Promise((resolve, reject) => {
    http.makeRequest(options, (err, res) => {
      if (err || !res) {
        reject(err || new Error('No response received from Wiim endpoint'));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`API Error: ${res.statusCode} ${res.statusMessage}`));
        return;
      }

      logger.debug(
        `httpCall Response for ${options.url}:`,
        `Status: ${res.statusCode} ${res.statusMessage}`,
        JSON.stringify(res.headers, null, '  '),
        res.content,
      );

      resolve(res);
    });
  });
};

const subscribeCall = async (options) => {
  logger.debug('Raw HTTP Options:', JSON.stringify(options, null, '\t'));
  const response = await rawHttp.makeRequest(options);

  if (response.statusCode !== 200) {
    throw new Error(
      `API Error: ${response.statusCode} ${response.statusMessage}`,
    );
  }

  return response;
};

const createSsdpSearchMessage = (searchTarget) =>
  Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      `MX: ${SSDP_DISCOVERY_MX}`,
      `ST: ${searchTarget}`,
      '',
      '',
    ].join('\r\n'),
  );

const parseSsdpHeaders = (payload) => {
  return payload
    .split(/\r?\n/)
    .slice(1)
    .reduce((headers, line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) {
        return headers;
      }

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();

      if (key) {
        headers[key] = value;
      }

      return headers;
    }, {});
};

const isMediaRenderer = (searchTarget) => {
  if (!searchTarget) {
    return false;
  }

  const normalized = searchTarget.toLowerCase();
  return normalized.includes('mediarenderer') || normalized.includes('rootdevice');
};

const extractRenderingControlService = (xml) => {
  const serviceRegex = /<service>([\s\S]*?)<\/service>/gi;
  let match;

  while ((match = serviceRegex.exec(xml)) !== null) {
    const block = match[1];
    if (!block || !block.includes(UPNP_MEDIA_RENDERER_SERVICE_SCHEMA)) {
      continue;
    }

    const controlUrlMatch = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
    const eventUrlMatch = block.match(/<eventSubURL>([^<]+)<\/eventSubURL>/i);

    if (controlUrlMatch && eventUrlMatch) {
      return {
        controlUrl: controlUrlMatch[1].trim(),
        eventUrl: eventUrlMatch[1].trim(),
      };
    }
  }

  return { controlUrl: null, eventUrl: null };
};

const extractXmlTagValue = (xml, tagName) => {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([^<]*)<\/${tagName}>`, 'i'));
  return match ? match[1].trim() : null;
};

const splitLocation = (location) => {
  const match = location.match(/^(https?):\/\/([^\/?#]+)([^?#]*)?.*/i);
  if (!match) {
    return null;
  }

  const protocol = match[1].toLowerCase();
  const host = match[2];
  const path = match[3] || '/';

  return {
    protocol,
    host,
    path,
  };
};

const resolveUrl = (baseLocation, relative) => {
  if (!relative) {
    return null;
  }

  if (/^https?:\/\//i.test(relative)) {
    return relative;
  }

  const parsed = splitLocation(baseLocation);
  if (!parsed) {
    return null;
  }

  const { protocol, host, path } = parsed;
  if (relative.startsWith('/')) {
    return `${protocol}://${host}${relative}`;
  }

  const baseDir = path.replace(/[^\/]*$/, '') || '/';
  const normalizedBase = baseDir.endsWith('/') ? baseDir : `${baseDir}/`;
  return `${protocol}://${host}${normalizedBase}${relative}`;
};

const parseDeviceDescription = (xml, location) => {
  if (!xml || !location) {
    return null;
  }

  const friendlyName = extractXmlTagValue(xml, 'friendlyName');
  if (!friendlyName) {
    return null;
  }

  const modelName = extractXmlTagValue(xml, 'modelName');
  if (!modelName) {
    return null;
  }

  const { controlUrl, eventUrl } = extractRenderingControlService(xml);
  if (!controlUrl || !eventUrl) {
    return null;
  }

  const parsedLocation = splitLocation(location);
  if (!parsedLocation) {
    logger.error(`Failed to parse device description location: ${location}`);
    return null;
  }

  const baseUrl = `${parsedLocation.protocol}://${parsedLocation.host}`;
  const absoluteControlUrl = resolveUrl(location, controlUrl);
  const absoluteEventUrl = resolveUrl(location, eventUrl);

  if (!absoluteControlUrl || !absoluteEventUrl) {
    logger.error('Failed to resolve control/event URLs for device description', {
      controlUrl,
      eventUrl,
      location,
    });
    return null;
  }

  return {
    name: friendlyName,
    model: modelName,
    location,
    baseUrl,
    controlUrl: absoluteControlUrl,
    eventUrl: absoluteEventUrl,
    usn: extractXmlTagValue(xml, 'UDN'),
  };
};

const fetchDeviceDescription = (location) => {
  return httpCall({
    url: location,
    method: 'GET',
  })
    .then((response) => {
      const device = parseDeviceDescription(response.content, location);
      if (!device) {
        logger.debug(`Ignoring UPnP device without rendering control service at ${location}`);
      }
      return device;
    })
    .catch((error) => {
      logger.error(`Failed to fetch device description from ${location}`, error);
      return null;
    });
};

const replaceLocationHost = (location, host) => {
  const match = location.match(/^(https?:\/\/)(?:\[[^\]]+\]|[^/:]+)(:\d+)?(\/.*)$/i);
  if (!match) {
    return null;
  }

  return `${match[1]}${host}${match[2] || ''}${match[3]}`;
};

const fetchGroupedDevices = (master) => {
  const parsedLocation = splitLocation(master.location);
  if (!parsedLocation) {
    return Promise.resolve([]);
  }

  const masterHost = parsedLocation.host.replace(/:\d+$/, '');
  return rawHttp
    .makeRequest({
      url: `https://${masterHost}${WIIM_SLAVE_LIST_PATH}`,
      method: 'GET',
      // WiiM uses a device-generated certificate on its local HTTPS API.
      rejectUnauthorized: false,
    })
    .then((response) => {
      if (response.statusCode !== 200) {
        throw new Error(
          `API Error: ${response.statusCode} ${response.statusMessage}`,
        );
      }

      const topology = JSON.parse(response.content);
      const slaves = Array.isArray(topology.slave_list) ? topology.slave_list : [];

      return (async () => {
        const devices = [];
        for (const slave of slaves) {
          if (!slave.ip) {
            continue;
          }

          const location = replaceLocationHost(master.location, slave.ip);
          if (!location) {
            logger.error(`Unable to construct UPnP location for ${slave.name}`);
            continue;
          }

          devices.push(await fetchDeviceDescription(location));
        }
        return devices;
      })();
    })
    .catch((error) => {
      logger.error(`Failed to discover grouped devices for ${master.name}`, error);
      return [];
    });
};

const discoverGroupedDevices = async () => {
  const visibleDevices = Array.from(wiimDevices.values());
  for (const master of visibleDevices) {
    const devices = await fetchGroupedDevices(master);
    devices.forEach((device) => registerDiscoveredDevice(device));
  }
};

const registerDiscoveredDevice = (device) => {
  if (!device) {
    return false;
  }

  if (!device.model.toLowerCase().includes('wiim')) {
    logger.debug(`Device model doesn't contain 'wiim'. Not registering device ${device.name}`);
    return false;
  }

  if (wiimDevices.has(device.name)) {
    logger.debug(`Wiim device with name ${device.name} already registered; skipping duplicate`);
    return false;
  }

  wiimDevices.set(device.name, device);
  logger.info(`Discovered Wiim device: ${device.name} (${device.baseUrl})`);

  const pendingVolume = pendingVolumeUpdates.get(device.name);
  if (typeof pendingVolume === 'number') {
    pendingVolumeUpdates.delete(device.name);
    logger.info(`Applying queued Twist volume for ${device.name}: ${pendingVolume}`);
    performSoapAction(device.name, 'SetVolume', {
      InstanceID: 0,
      Channel: 'Single',
      DesiredVolume: pendingVolume,
    });
  }

  return true;
};

const discoverWiimDevices = (timeoutMs = SSDP_DISCOVERY_TIMEOUT_MS) => {
  logger.info(`Starting Wiim SSDP discovery (timeout ${timeoutMs}ms)`);
  wiimDevices.clear();

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const pendingDescriptions = new Set();
    const discoveredLocations = new Set();
    let finalized = false;

    const finalize = () => {
      if (finalized) {
        return;
      }
      finalized = true;

      try {
        socket.close();
      } catch (error) {
        logger.debug('Error while closing SSDP discovery socket', error);
      }

      Promise.all(Array.from(pendingDescriptions))
        .then(() => discoverGroupedDevices())
        .catch((error) => logger.error('Error resolving discovery promises', error))
        .finally(() => {
          if (wiimDevices.size === 0) {
            logger.error('No Wiim devices discovered via SSDP');
          } else {
            logger.info(`Wiim SSDP discovery complete (found ${wiimDevices.size})`);
          }
          resolve(wiimDevices);
        });
    };

    socket.on('message', (message) => {
      const payload = message.toString();
      const headers = parseSsdpHeaders(payload);

      const searchTarget = headers.st || headers.nt;
      if (!isMediaRenderer(searchTarget)) {
        return;
      }

      const location = headers.location;
      if (!location || discoveredLocations.has(location)) {
        return;
      }

      discoveredLocations.add(location);
      logger.debug(`SSDP response received for ${location}`);

      const descriptionPromise = fetchDeviceDescription(location).then((device) => {
        registerDiscoveredDevice(device);
      });

      pendingDescriptions.add(descriptionPromise);
      descriptionPromise.finally(() => pendingDescriptions.delete(descriptionPromise));
    });

    socket.on('error', (error) => {
      logger.error('SSDP discovery socket error', error);
      finalize();
    });

    socket.on('listening', () => {
      const { address, port } = socket.address();
      logger.debug(`SSDP discovery socket listening on ${address}:${port}`);

      SSDP_SEARCH_TARGETS.forEach((target, index) => {
        const message = createSsdpSearchMessage(target);
        const label = index === 0 ? 'initial' : 'follow-up';
        logger.debug(`Sending ${label} SSDP M-SEARCH probe for ${target}`);
        socket.send(message, 0, message.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS);
      });

      // Some devices ignore the first packet; resend for each target after short delay
      setTimeout(() => {
        if (finalized) {
          return;
        }
        SSDP_SEARCH_TARGETS.forEach((target) => {
          const message = createSsdpSearchMessage(target);
          logger.debug(`Sending retry SSDP M-SEARCH probe for ${target}`);
          socket.send(message, 0, message.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS);
        });
      }, 750);
    });

    // M-SEARCH responses return to the sender's source port, so an ephemeral
    // port avoids competing with the hub's own SSDP service on port 1900.
    socket.bind(0);

    setTimeout(() => {
      finalize();
    }, timeoutMs);
  });
};

const subscriptions = new Map();
const wiimDevices = new Map();
const pendingVolumeUpdates = new Map();
let callbackServerAddress = null;

const SUBSCRIPTION_STATE = {
  IDLE: 'idle',
  SUBSCRIBING: 'subscribing',
  SUBSCRIBED: 'subscribed',
  RENEWING: 'renewing',
  RETRYING: 'retrying',
  FAILED: 'failed',
};

const getOrCreateSubscription = (virtualDeviceId) => {
  if (!subscriptions.has(virtualDeviceId)) {
    subscriptions.set(virtualDeviceId, {
      state: SUBSCRIPTION_STATE.IDLE,
      retryCount: 0,
      sid: null,
      serverAddress: null,
      timer: null,
    });
  }

  return subscriptions.get(virtualDeviceId);
};

const transitionSubscription = (virtualDeviceId, nextState, updates = {}) => {
  const record = getOrCreateSubscription(virtualDeviceId);

  if (record.timer && updates.timer === null) {
    clearTimeout(record.timer);
  }

  if (record.timer && updates.timer && updates.timer !== record.timer) {
    clearTimeout(record.timer);
  }

  if (updates.timer !== undefined) {
    record.timer = updates.timer;
  }

  if (updates.sid !== undefined) {
    record.sid = updates.sid;
  }

  if (updates.serverAddress !== undefined) {
    record.serverAddress = updates.serverAddress;
  }

  if (updates.retryCount !== undefined) {
    record.retryCount = updates.retryCount;
  }

  record.state = nextState;
  subscriptions.set(virtualDeviceId, record);
  return record;
};

const queueRetry = ({
  virtualDeviceId,
  nextState,
  action,
  serverAddress,
  delayMs = SUBSCRIPTION_RETRY_DELAY_MS,
}) => {
  const record = getOrCreateSubscription(virtualDeviceId);
  const retryCount = (record.retryCount || 0) + 1;

  if (retryCount > SUBSCRIPTION_MAX_RETRIES) {
    logger.error(
      `UPNP subscription retries exhausted for ${virtualDeviceId}; giving up until restart`,
    );
    transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.FAILED, {
      retryCount,
      timer: null,
    });
    return;
  }

  const timer = setTimeout(() => {
    transitionSubscription(virtualDeviceId, nextState, {
      timer: null,
      retryCount,
      serverAddress: serverAddress || record.serverAddress || callbackServerAddress,
    });
    action();
  }, delayMs);

  transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.RETRYING, {
    retryCount,
    timer,
    serverAddress: serverAddress || record.serverAddress || callbackServerAddress,
  });
};

const scheduleRenewal = (virtualDeviceId) => {
  const staggerSeconds = Array.from(virtualDeviceId).reduce(
    (hash, character) => (hash + character.charCodeAt(0)) % SUBSCRIPTION_RENEWAL_STAGGER_SECONDS,
    0,
  );
  const delaySeconds = Math.max(
    1,
    SUBSCRIPTION_TIMEOUT_SECONDS -
      SUBSCRIPTION_RENEWAL_MARGIN_SECONDS +
      staggerSeconds,
  );

  const timer = setTimeout(() => {
    transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.RENEWING, {
      timer: null,
    });
    renewSubscription(virtualDeviceId);
  }, delaySeconds * 1000);

  transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.SUBSCRIBED, {
    timer,
    retryCount: 0,
  });
};

const renewSubscription = (virtualDeviceId) => {
  const device = wiimDevices.get(virtualDeviceId);
  if (!device) {
    logger.error(`Unable to renew, unknown virtual device: ${virtualDeviceId}`);
    transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.FAILED, {
      sid: null,
      timer: null,
    });
    return;
  }

  const record = getOrCreateSubscription(virtualDeviceId);
  const serverAddress = record.serverAddress || callbackServerAddress;

  if (!record.sid) {
    logger.error(`Unable to renew ${virtualDeviceId}, missing SID`);
    queueRetry({
      virtualDeviceId,
      nextState: SUBSCRIPTION_STATE.SUBSCRIBING,
      action: () => {
        subscribeToNotifications(virtualDeviceId, serverAddress);
      },
      serverAddress,
    });
    return;
  }

  const options = {
    url: device.eventUrl,
    method: 'SUBSCRIBE',
    headers: {
      SID: record.sid,
      TIMEOUT: toTimeoutHeader(SUBSCRIPTION_TIMEOUT_SECONDS),
    },
  };

  return subscribeCall(options)
    .then((response) => {
      const nextSid = getHeaderValue(response.headers, 'sid') || record.sid;
      logger.debug(`UPNP Renewed: ${virtualDeviceId}`);
      transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.SUBSCRIBED, {
        sid: nextSid,
        retryCount: 0,
      });
      scheduleRenewal(virtualDeviceId);
    })
    .catch((error) => {
      logger.error(`UPNP unable to renew subscription for ${virtualDeviceId}`, error);
      queueRetry({
        virtualDeviceId,
        nextState: SUBSCRIPTION_STATE.RENEWING,
        action: () => {
          renewSubscription(virtualDeviceId);
        },
        serverAddress,
      });
    });
};

const upnpEndpointFor = (virtualDeviceId) => {
  const device = wiimDevices.get(virtualDeviceId);
  if (!device) {
    throw new Error(`Unknown virtual device: ${virtualDeviceId}`);
  }

  return device.controlUrl;
};

const performSoapAction = (virtualDeviceId, action, props) => {
  let controlUrl;
  try {
    controlUrl = upnpEndpointFor(virtualDeviceId);
  } catch (error) {
    logger.error(error);
    return Promise.resolve();
  }

  const options = {
    url: controlUrl,
    method: 'POST',
    headers: {
      SOAPACTION: `"${UPNP_MEDIA_RENDERER_SERVICE_SCHEMA}#${action}"`,
      'CONTENT-TYPE': 'text/xml; charset="utf-8"',
    },
    content: createSoapBody(action, props),
  };

  return httpCall(options).catch((error) => {
    logger.error(`SOAP action failed for ${virtualDeviceId} (${action})`, error);
  });
};

const subscribeToNotifications = (virtualDeviceId, serverAddress) => {
  const device = wiimDevices.get(virtualDeviceId);
  if (!device) {
    logger.error(`Unable to subscribe, unknown virtual device: ${virtualDeviceId}`);
    transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.FAILED, {
      sid: null,
      timer: null,
    });
    return;
  }

  if (!serverAddress) {
    logger.error(
      `Unable to subscribe ${virtualDeviceId}, callback server address unavailable`,
    );
    queueRetry({
      virtualDeviceId,
      nextState: SUBSCRIPTION_STATE.SUBSCRIBING,
      action: () => {
        subscribeToNotifications(virtualDeviceId, callbackServerAddress);
      },
    });
    return;
  }

  const hubAddress = getHubAddress();
  if (!hubAddress) {
    logger.error('Unable to subscribe, Flic Hub network address unavailable');
    queueRetry({
      virtualDeviceId,
      nextState: SUBSCRIPTION_STATE.SUBSCRIBING,
      action: () => subscribeToNotifications(virtualDeviceId, serverAddress),
      serverAddress,
    });
    return;
  }

  transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.SUBSCRIBING, {
    serverAddress,
  });

  const options = {
    url: device.eventUrl,
    method: 'SUBSCRIBE',
    headers: {
      CALLBACK: `<http://${hubAddress}:${serverAddress.port}/${encodeURI(
        virtualDeviceId,
      )}>`,
      NT: 'upnp:event',
      TIMEOUT: toTimeoutHeader(SUBSCRIPTION_TIMEOUT_SECONDS),
    },
  };

  return subscribeCall(options)
    .then((response) => {
      const sid = getHeaderValue(response.headers, 'sid');
      logger.info(`UPNP Subscribed: ${virtualDeviceId}`);

      if (!sid) {
        logger.error(`UPNP subscription missing SID for ${virtualDeviceId}`);
        queueRetry({
          virtualDeviceId,
          nextState: SUBSCRIPTION_STATE.SUBSCRIBING,
          action: () => {
            subscribeToNotifications(virtualDeviceId, serverAddress);
          },
          serverAddress,
        });
        return;
      }

      transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.SUBSCRIBED, {
        sid,
        retryCount: 0,
        serverAddress,
      });
      scheduleRenewal(virtualDeviceId);
    })
    .catch((error) => {
      logger.error(`UPNP unable to subscribe to ${virtualDeviceId}`, error);
      queueRetry({
        virtualDeviceId,
        nextState: SUBSCRIPTION_STATE.SUBSCRIBING,
        action: () => {
          subscribeToNotifications(virtualDeviceId, serverAddress);
        },
        serverAddress,
      });
    });
};

const parseUpnpEvent = (payload) => {
  if (!payload) {
    return {};
  }

  const deviceMatch = payload.match(/NOTIFY \/(\S+)/);
  const volumeMatch =
    payload.match(
      /\bVolume\b(?:\s+[A-Za-z_:][\w:.-]*="[^"]*")*\s+val="(\d+)"/,
    ) ||
    payload.match(/\bSlaveVolume="(\d+)"/);

  const virtualDeviceId = deviceMatch ? decodeURI(deviceMatch[1]) : null;
  const volume = volumeMatch ? Number(volumeMatch[1]) : null;

  return { virtualDeviceId, volume };
};

const createCallbackServer = () => {
  const server = new net.Server((socket) => {
    let payload = '';
    let handled = false;

    socket.on('error', (error) => {
      logger.error(error);
    });

    socket.on('end', () => {
      logger.debug('Callback client disconnected');
    });

    socket.on('data', (data) => {
      payload += data.toString();

      const headerEnd = payload.indexOf('\r\n\r\n');
      if (headerEnd === -1 || handled) {
        return;
      }

      const headers = payload.slice(0, headerEnd);
      const contentLengthMatch = headers.match(/(?:^|\r\n)CONTENT-LENGTH:\s*(\d+)/i);
      const contentLength = contentLengthMatch ? Number(contentLengthMatch[1]) : 0;
      if (payload.length < headerEnd + 4 + contentLength) {
        return;
      }

      handled = true;
      logger.debug('Callback Received:', SEPARATOR, payload, SEPARATOR);

      const { virtualDeviceId, volume } = parseUpnpEvent(payload);

      if (!virtualDeviceId) {
        logger.error('UPNP Event: Missing virtual device identifier', payload);
        socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }

      if (typeof volume === 'number') {
        logger.info(`UPNP Event: ${virtualDeviceId} - ${volume}`);
        flicapp.virtualDeviceUpdateState('Speaker', virtualDeviceId, {
          volume: denormalizeVolume(volume),
        });
        logger.info(`Virtual Device Updated: ${virtualDeviceId} - ${volume}`);
      } else {
        logger.debug(`UPNP Event: ${virtualDeviceId} - No volume change`, payload);
      }

      socket.end(
        'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    });
  });
  
  return server;
};

const callbackServer = createCallbackServer();

callbackServer.on('error', (error) => {
  logger.error('UPNP callback server error', error);
});

callbackServer.listen(CALLBACK_PORT, async () => {
  try {
    const serverAddress = callbackServer.address();
    if (!serverAddress) {
      logger.error(new Error('Callback server address unavailable'));
      return;
    }

    callbackServerAddress = serverAddress;

    logger.info(
      `Listening on ${serverAddress.address}:${serverAddress.port}`,
      SEPARATOR,
    );

    await discoverWiimDevices();
    if (wiimDevices.size === 0) {
      logger.error(
        'No Wiim devices discovered; restart the module to retry discovery',
      );
    } else {
      for (const virtualDeviceId of wiimDevices.keys()) {
        await subscribeToNotifications(virtualDeviceId, serverAddress);
      }
    }

    logger.info('Wiim discovery and subscriptions initialized');
  } catch (error) {
    logger.error('Wiim initialization failed', error);
  }
});

const handleVirtualDeviceUpdate = (metaData, values) => {
  const { virtualDeviceId } = metaData;
  const rawVolume = values.volume;
  const numericVolume = typeof rawVolume === 'number' ? rawVolume : Number(rawVolume);

  if (Number.isNaN(numericVolume)) {
    logger.error('Twist Event: Unrecognized volume attribute', values);
    return;
  }

  const desiredVolume = normalizeVolume(numericVolume);
  logger.info(`Twist Event: ${virtualDeviceId} - ${desiredVolume}`);

  if (!wiimDevices.has(virtualDeviceId)) {
    pendingVolumeUpdates.set(virtualDeviceId, desiredVolume);
    logger.info(`Queued Twist volume until discovery finds ${virtualDeviceId}`);
    return;
  }

  performSoapAction(virtualDeviceId, 'SetVolume', {
    InstanceID: 0,
    Channel: 'Single',
    DesiredVolume: desiredVolume,
  });
};

flicapp.on('virtualDeviceUpdate', throttle(handleVirtualDeviceUpdate));

setInterval(() => {
  const activeSubscriptions = Array.from(subscriptions.values()).filter(
    (subscription) => subscription.state === SUBSCRIPTION_STATE.SUBSCRIBED,
  ).length;
  logger.info(
    `Wiim service healthy (${wiimDevices.size} devices, ${activeSubscriptions} subscriptions)`,
  );
}, HEALTH_LOG_INTERVAL_MS);
