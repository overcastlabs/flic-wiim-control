import flicapp = require('flicapp');
import { parseActionMessage } from './action-message';
import config from './config';
import { createEventServer } from './event-server';
import { logger } from './logger';
import { createSubscriptionManager } from './subscription-manager';
import { denormalizeVolume, normalizeVolume } from './upnp-protocol';
import { createController } from './wiim-controller';
import { createDiscovery } from './wiim-discovery';
import type { ActionMessage, DeviceMap, WiimDevice } from './types';
import type {
  VirtualDeviceMetadata,
  VirtualDeviceValues,
} from 'flicapp';

const devices: DeviceMap = new Map();
const pendingVolumes = new Map<string, number>();
const controller = createController({ devices });

const applyPendingVolume = (device: WiimDevice): void => {
  const volume = pendingVolumes.get(device.name);
  if (volume === undefined) {
    return;
  }

  pendingVolumes.delete(device.name);
  logger.info(`Applying queued volume for ${device.name}: ${volume}`);
  void controller.setVolume(device.name, volume);
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

const throttle = <Arguments extends unknown[]>(
  handler: (...args: Arguments) => void,
  delayMs = 125,
): ((...args: Arguments) => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Arguments): void => {
    if (timer !== null) {
      return;
    }
    handler(...args);
    timer = setTimeout(() => {
      timer = null;
    }, delayMs);
  };
};

const handleVolumeUpdate = (
  { virtualDeviceId }: VirtualDeviceMetadata,
  { volume }: VirtualDeviceValues,
): void => {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) {
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
  void controller.setVolume(virtualDeviceId, normalizedVolume);
};

const handleActionMessage = (message: string): void => {
  let action: ActionMessage;
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
    void controller.playPreset(action.deviceId, action.preset);
    return;
  }
  void controller.sendTransportCommand(action.deviceId, action.command);
};

flicapp.on('virtualDeviceUpdate', throttle(handleVolumeUpdate));
flicapp.on('actionMessage', handleActionMessage);

eventServer.on('error', (error) => {
  logger.error('UPnP callback server error', error);
});

// Omitting the port asks the Hub OS to choose an available ephemeral port.
eventServer.listen(async () => {
  try {
    const serverAddress = eventServer.address();
    if (!serverAddress || typeof serverAddress === 'string') {
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
