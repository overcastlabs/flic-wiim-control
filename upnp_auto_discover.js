'use strict';

// So Close! Wiims don't respond to SSDP discovery when linked to other Wiims

const flicapp = require('flicapp');
const dgram = require('dgram');
const http = require('http');
const net = require('net');

// -----------------
// Configuration
// -----------------
const FLIC_ADDRESS = '192.168.1.177';
const DEBUG = false;

// -----------------
// Constants
// -----------------
const SEPARATOR = '-------------';
const CALLBACK_PORT = 44445;
const SUBSCRIPTION_TIMEOUT_SECONDS = 10 * 60; // 10min
const SUBSCRIPTION_RENEWAL_MARGIN_SECONDS = 5;
const SUBSCRIPTION_RETRY_DELAY_MS = 5000;
const SUBSCRIPTION_MAX_RETRIES = 5;
const SSDP_MULTICAST_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_DISCOVERY_MX = 3; // SSDP device response jitter in seconds
const SSDP_DISCOVERY_TIMEOUT_MS = SSDP_DISCOVERY_MX * 1000 + 250;
const WIIM_DEVICE_SERVICE_TYPE = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const SSDP_SEARCH_TARGETS = ['upnp:rootdevice', WIIM_DEVICE_SERVICE_TYPE];
const UPNP_MEDIA_RENDERER_SERVICE_SCHEMA = 'urn:schemas-upnp-org:service:RenderingControl:1';

const logger = {
  info: (...args) => console.log(`INFO: ${args.shift()}`, ...args),
  error: (...args) => console.log(`ERROR: ${args.shift()}`, ...args),
  debug: (...args) => {
    if (DEBUG) {
      console.log(`DEBUG: ${args.shift()}`, ...args);
    }
  },
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

    socket.bind(SSDP_PORT);

    setTimeout(() => {
      finalize();
    }, timeoutMs);
  });
};

const subscriptions = new Map();
const wiimDevices = new Map();
let callbackServerAddress = null;
let ssdpAnnouncementSocket = null;

const hasDeviceWithLocation = (location) => {
  if (!location) {
    return false;
  }

  for (const device of wiimDevices.values()) {
    if (device.location === location) {
      return true;
    }
  }

  return false;
};

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
  const delaySeconds = Math.max(
    1,
    SUBSCRIPTION_TIMEOUT_SECONDS - SUBSCRIPTION_RENEWAL_MARGIN_SECONDS,
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

  return httpCall(options)
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

  transitionSubscription(virtualDeviceId, SUBSCRIPTION_STATE.SUBSCRIBING, {
    serverAddress,
  });

  const options = {
    url: device.eventUrl,
    method: 'SUBSCRIBE',
    headers: {
      CALLBACK: `<http://${FLIC_ADDRESS}:${serverAddress.port}/${encodeURI(
        virtualDeviceId,
      )}>`,
      NT: 'upnp:event',
      TIMEOUT: toTimeoutHeader(SUBSCRIPTION_TIMEOUT_SECONDS),
    },
  };

  // Can't actually init subscription because Flic doesn't support SUBSCRIBE http verb
  // curl -v http://192.168.1.237:59152/upnp/event/rendercontrol1 -H "CALLBACK: <http://192.168.1.177:44444/Guest%20Speakers>" -H "NT: upnp:event" -H "TIMEOUT: Second-1800" -X SUBSCRIBE
  logger.info(`Would have subscribed to ${device.name} if I could`);
  return;

  return httpCall(options)
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

const startSsdpAnnouncementListener = () => {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (error) => {
    logger.error('SSDP announcement socket error', error);
  });

  socket.on('listening', () => {
    const { address, port } = socket.address();
    logger.info(`Listening for SSDP announcements on ${address}:${port}`);

    try {
      socket.addMembership(SSDP_MULTICAST_ADDRESS);
    } catch (error) {
      logger.error('Failed to join SSDP multicast group', error);
    }
  });

  socket.on('message', (message) => {
    const payload = message.toString();
    const headers = parseSsdpHeaders(payload);
    const notificationType = headers.nts ? headers.nts.toLowerCase() : null;

    if (notificationType !== 'ssdp:alive') {
      return;
    }

    const searchTarget = headers.nt || headers.st;
    if (!isMediaRenderer(searchTarget)) {
      return;
    }

    const location = headers.location;
    if (!location || hasDeviceWithLocation(location)) {
      return;
    }

    logger.info(`SSDP announcement detected for ${location}`);
    fetchDeviceDescription(location).then((device) => {
      const isNewDevice = registerDiscoveredDevice(device);
      if (!isNewDevice || !device) {
        return;
      }

      if (!callbackServerAddress) {
        logger.error(
          `Callback server address unavailable; skipping subscription for ${device.name}`,
        );
        return;
      }

      subscribeToNotifications(device.name, callbackServerAddress);
    });
  });

  socket.bind(SSDP_PORT);
  return socket;
};

const parseUpnpEvent = (payload) => {
  if (!payload) {
    return {};
  }

  const deviceMatch = payload.match(/NOTIFY \/(\S+)/);
  const volumeMatch = payload.match(/Volume.+val="(\d+)"/);

  const virtualDeviceId = deviceMatch ? decodeURI(deviceMatch[1]) : null;
  const volume = volumeMatch ? Number(volumeMatch[1]) : null;

  return { virtualDeviceId, volume };
};

const createCallbackServer = () => {
  const server = new net.Server((socket) => {
    socket.on('error', (error) => {
      logger.error(error);
    });

    socket.on('end', () => {
      logger.debug('Callback client disconnected');
    });

    socket.on('data', (data) => {
      const payload = data.toString();
      logger.debug('Callback Received:', SEPARATOR, payload, SEPARATOR);

      const { virtualDeviceId, volume } = parseUpnpEvent(payload);

      if (!virtualDeviceId) {
        logger.error('UPNP Event: Missing virtual device identifier', payload);
        socket.end('OK');
        return;
      }

      if (typeof volume === 'number') {
        logger.info(`UPNP Event: ${virtualDeviceId} - ${volume}`);
        flicapp.virtualDeviceUpdateState('Speaker', virtualDeviceId, {
          volume: denormalizeVolume(volume),
        });
        logger.info(`Virtual Device Updated: ${virtualDeviceId} - ${volume}`);
      } else {
        logger.error(`UPNP Event: ${virtualDeviceId} - Unrecognized event`, payload);
      }

      socket.end('OK');
    });
  });
  
  return server;
};

const callbackServer = createCallbackServer();

callbackServer.listen(CALLBACK_PORT, async () => {
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
      'No Wiim devices discovered; waiting for SSDP announcements to initialize subscriptions',
    );
  } else {
    await Promise.all(
      Array.from(wiimDevices.keys()).map((virtualDeviceId) =>
        subscribeToNotifications(virtualDeviceId, serverAddress),
      ),
    );
  }

  if (!ssdpAnnouncementSocket) {
    ssdpAnnouncementSocket = startSsdpAnnouncementListener();
  }

  // Prevent the async listen callback from resolving so QuickJS keeps the module alive.
  await new Promise(() => {});
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

  performSoapAction(virtualDeviceId, 'SetVolume', {
    InstanceID: 0,
    Channel: 'Single',
    DesiredVolume: desiredVolume,
  });
};

flicapp.on('virtualDeviceUpdate', throttle(handleVirtualDeviceUpdate));
