'use strict';

const flicapp = require('flicapp');
const { parseActionMessage } = require('./action-message');
const config = require('./config');
const { createEventServer } = require('./event-server');
const logger = require('./logger');
const { createSubscriptionManager } = require('./subscription-manager');
const { denormalizeVolume, normalizeVolume } = require('./upnp-protocol');
const { createController } = require('./wiim-controller');
const { createDiscovery } = require('./wiim-discovery');

const devices = new Map();
const pendingVolumes = new Map();
const controller = createController({ devices });

const applyPendingVolume = (device) => {
  const volume = pendingVolumes.get(device.name);
  if (typeof volume !== 'number') {
    return;
  }

  pendingVolumes.delete(device.name);
  logger.info(`Applying queued volume for ${device.name}: ${volume}`);
  controller.setVolume(device.name, volume);
};

const discovery = createDiscovery({
  devices,
  onDeviceDiscovered: applyPendingVolume,
});
const subscriptions = createSubscriptionManager({ devices });

const eventServer = createEventServer({
  onVolume: (deviceId, volume) => {
    logger.info(`UPnP volume event: ${deviceId} - ${volume}`);
    flicapp.virtualDeviceUpdateState('Speaker', deviceId, {
      volume: denormalizeVolume(volume),
    });
  },
});

const throttle = (handler, delayMs = 125) => {
  let timer = null;
  return (...args) => {
    if (timer !== null) {
      return;
    }
    handler(...args);
    timer = setTimeout(() => {
      timer = null;
    }, delayMs);
  };
};

const handleVolumeUpdate = ({ virtualDeviceId }, { volume }) => {
  if (!Number.isFinite(volume)) {
    logger.error('Ignoring invalid Twist volume update', volume);
    return;
  }

  const normalizedVolume = normalizeVolume(volume);
  if (!devices.has(virtualDeviceId)) {
    pendingVolumes.set(virtualDeviceId, normalizedVolume);
    logger.info(`Queued volume until discovery finds ${virtualDeviceId}`);
    return;
  }

  logger.info(`Twist volume event: ${virtualDeviceId} - ${normalizedVolume}`);
  controller.setVolume(virtualDeviceId, normalizedVolume);
};

const handleActionMessage = (message) => {
  let action;
  try {
    action = parseActionMessage(message);
  } catch (error) {
    logger.error('Ignoring invalid action message', error);
    return;
  }

  if (!devices.has(action.deviceId)) {
    logger.error(`Action targets an unknown WiiM device: ${action.deviceId}`);
    return;
  }

  logger.info(`Action message: ${action.deviceId} - ${action.command}`);
  if (action.command === 'preset') {
    controller.playPreset(action.deviceId, action.preset);
    return;
  }
  controller.sendTransportCommand(action.deviceId, action.command);
};

flicapp.on('virtualDeviceUpdate', throttle(handleVolumeUpdate));
flicapp.on('actionMessage', handleActionMessage);

eventServer.on('error', (error) => {
  logger.error('UPnP callback server error', error);
});

eventServer.listen(config.callbackPort, async () => {
  try {
    const serverAddress = eventServer.address();
    if (!serverAddress) {
      throw new Error('UPnP callback server address is unavailable');
    }

    logger.info(`Listening on ${serverAddress.address}:${serverAddress.port}`);
    await discovery.discover();
    if (devices.size === 0) {
      logger.error('No WiiM devices discovered; restart the module to retry');
      return;
    }

    await subscriptions.subscribeAll(serverAddress);
    logger.info('WiiM discovery and subscriptions initialized');
  } catch (error) {
    logger.error('WiiM initialization failed', error);
  }
});

setInterval(() => {
  logger.info(
    `WiiM service healthy (${devices.size} devices, ${subscriptions.activeCount()} subscriptions)`,
  );
}, config.healthLogIntervalMs);
