'use strict';

const flicapp = require('flicapp');
const http = require('http');
const net = require('net');
const network = require('network');
const rawHttp = require('./raw-http');

const DEBUG = false;

// -----------------
// Configuration
// -----------------
const SEPARATOR = '-------------';
const UPNP_PORT = '59152';
const CALLBACK_PORT = 44444;
const SUBSCRIPTION_TIMEOUT_SECONDS = 30;
const SUBSCRIPTION_RENEWAL_MARGIN_SECONDS = 5;
const SUBSCRIPTION_RETRY_DELAY_MS = 5000;
const SUBSCRIPTION_MAX_RETRIES = 5;

// Use Virtual Device IDs set up in Flic app as keys
const WIIM_HOSTS = {
  'Guest Room Speakers': `http://192.168.1.237:${UPNP_PORT}`,
  'Downstairs Speakers': `http://192.168.1.41:${UPNP_PORT}`,
};

const UPNP_MEDIA_RENDERER_SERVICE_SCHEMA =
  'urn:schemas-upnp-org:service:RenderingControl:1';

const logger = {
  info: console.log,
  error: (...args) => console.log(...args),
  debug: (...args) => {
    if (DEBUG) {
      console.log(...args);
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
        'httpCall Response:',
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

const subscriptions = new Map();
let callbackServerAddress = null;

const clearSubscriptionTimer = (virtualDeviceId) => {
  const subscription = subscriptions.get(virtualDeviceId);
  if (subscription?.timer) {
    clearTimeout(subscription.timer);
  }
};

const scheduleSubscriptionRenewal = (virtualDeviceId, sid, serverAddress) => {
  if (!sid) {
    scheduleSubscriptionRestart(virtualDeviceId, serverAddress);
    return;
  }

  clearSubscriptionTimer(virtualDeviceId);

  const renewalDelaySeconds = Math.max(
    1,
    SUBSCRIPTION_TIMEOUT_SECONDS - SUBSCRIPTION_RENEWAL_MARGIN_SECONDS,
  );

  const timer = setTimeout(() => {
    renewSubscription(virtualDeviceId);
  }, renewalDelaySeconds * 1000);

  subscriptions.set(virtualDeviceId, { sid, timer, serverAddress, retryCount: 0 });
};

const scheduleSubscriptionRestart = (
  virtualDeviceId,
  serverAddress,
  delayMs = SUBSCRIPTION_RETRY_DELAY_MS,
) => {
  if (!serverAddress) {
    subscriptions.delete(virtualDeviceId);
    return;
  }

  const current = subscriptions.get(virtualDeviceId);
  const retryCount = (current?.retryCount || 0) + 1;

  if (retryCount > SUBSCRIPTION_MAX_RETRIES) {
    logger.error(
      `UPNP subscription retries exhausted for ${virtualDeviceId}; giving up until restart`,
    );
    clearSubscriptionTimer(virtualDeviceId);
    subscriptions.delete(virtualDeviceId);
    return;
  }

  clearSubscriptionTimer(virtualDeviceId);

  const timer = setTimeout(() => {
    subscribeToNotifications(virtualDeviceId, serverAddress);
  }, delayMs);

  subscriptions.set(virtualDeviceId, {
    sid: null,
    timer,
    serverAddress,
    retryCount,
  });
};

const renewSubscription = (virtualDeviceId) => {
  const host = WIIM_HOSTS[virtualDeviceId];
  if (!host) {
    logger.error(`Unable to renew, unknown virtual device: ${virtualDeviceId}`);
    subscriptions.delete(virtualDeviceId);
    return;
  }

  const subscription = subscriptions.get(virtualDeviceId);
  if (!subscription || !subscription.sid) {
    const serverAddress = subscription?.serverAddress || callbackServerAddress;
    scheduleSubscriptionRestart(virtualDeviceId, serverAddress);
    return;
  }

  const options = {
    url: `${host}/upnp/event/rendercontrol1`,
    method: 'SUBSCRIBE',
    headers: {
      SID: subscription.sid,
      TIMEOUT: toTimeoutHeader(SUBSCRIPTION_TIMEOUT_SECONDS),
    },
  };

  return subscribeCall(options)
    .then((response) => {
      const nextSid = getHeaderValue(response.headers, 'sid') || subscription.sid;
      logger.debug(`UPNP Renewed: ${virtualDeviceId}`);
      scheduleSubscriptionRenewal(
        virtualDeviceId,
        nextSid,
        subscription.serverAddress || callbackServerAddress,
      );
    })
    .catch((error) => {
      logger.error(`UPNP unable to renew subscription for ${virtualDeviceId}`, error);
      const serverAddress = subscription?.serverAddress || callbackServerAddress;
      scheduleSubscriptionRestart(virtualDeviceId, serverAddress);
    });
};

const upnpEndpointFor = (virtualDeviceId) => {
  const host = WIIM_HOSTS[virtualDeviceId];
  if (!host) {
    throw new Error(`Unknown virtual device: ${virtualDeviceId}`);
  }

  return `${host}/upnp/control/rendercontrol1`;
};

const performSoapAction = (virtualDeviceId, action, props) => {
  const options = {
    url: upnpEndpointFor(virtualDeviceId),
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
  const host = WIIM_HOSTS[virtualDeviceId];
  if (!host) {
    logger.error(`Unable to subscribe, unknown virtual device: ${virtualDeviceId}`);
    subscriptions.delete(virtualDeviceId);
    return;
  }

  if (!serverAddress) {
    logger.error(
      `Unable to subscribe ${virtualDeviceId}, callback server address unavailable`,
    );
    scheduleSubscriptionRestart(virtualDeviceId, callbackServerAddress);
    return;
  }

  const hubAddress = getHubAddress();
  if (!hubAddress) {
    logger.error('Unable to subscribe, Flic Hub network address unavailable');
    scheduleSubscriptionRestart(virtualDeviceId, serverAddress);
    return;
  }

  const options = {
    url: `${host}/upnp/event/rendercontrol1`,
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
        scheduleSubscriptionRestart(virtualDeviceId, serverAddress);
        return;
      }

      scheduleSubscriptionRenewal(virtualDeviceId, sid, serverAddress);
    })
    .catch((error) => {
      logger.error(`UPNP unable to subscribe to ${virtualDeviceId}`, error);
      scheduleSubscriptionRestart(virtualDeviceId, serverAddress);
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

  await Promise.all(
    Object.keys(WIIM_HOSTS).map((virtualDeviceId) =>
      subscribeToNotifications(virtualDeviceId, serverAddress),
    ),
  );
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
