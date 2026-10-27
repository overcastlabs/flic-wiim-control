import type { AddressInfo } from 'net';
import config from './config';
import { rawRequest } from './http-client';
import { logger } from './logger';
import { getHubAddress } from './network-utils';
import { getHeaderValue, toTimeoutHeader } from './upnp-protocol';
import type { DeviceMap } from './types';

const STATE = {
  idle: 'idle',
  subscribing: 'subscribing',
  subscribed: 'subscribed',
  renewing: 'renewing',
  retrying: 'retrying',
  failed: 'failed',
} as const;

type SubscriptionState = (typeof STATE)[keyof typeof STATE];

interface SubscriptionRecord {
  state: SubscriptionState;
  retryCount: number;
  sid: string | null;
  serverAddress: AddressInfo | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface SubscriptionManagerOptions {
  readonly devices: DeviceMap;
}

type RecordUpdates = Partial<Omit<SubscriptionRecord, 'state'>>;
type RetryAction = () => void | Promise<void>;
type Subscribe = (
  deviceId: string,
  serverAddress?: AddressInfo | null,
) => Promise<void>;

export const createSubscriptionManager = ({
  devices,
}: SubscriptionManagerOptions) => {
  const subscriptions = new Map<string, SubscriptionRecord>();
  let callbackServerAddress: AddressInfo | null = null;

  const getRecord = (deviceId: string): SubscriptionRecord => {
    let record = subscriptions.get(deviceId);
    if (!record) {
      record = {
        state: STATE.idle,
        retryCount: 0,
        sid: null,
        serverAddress: null,
        timer: null,
      };
      subscriptions.set(deviceId, record);
    }
    return record;
  };

  const transition = (
    deviceId: string,
    state: SubscriptionState,
    updates: RecordUpdates = {},
  ): SubscriptionRecord => {
    const record = getRecord(deviceId);
    if (
      record.timer &&
      updates.timer !== undefined &&
      updates.timer !== record.timer
    ) {
      clearTimeout(record.timer);
    }

    Object.assign(record, updates, { state });
    subscriptions.set(deviceId, record);
    return record;
  };

  const scheduleRetry = (
    deviceId: string,
    action: RetryAction,
    serverAddress: AddressInfo | null,
  ): void => {
    const record = getRecord(deviceId);
    const retryCount = record.retryCount + 1;
    if (retryCount > config.subscription.maxRetries) {
      logger.error(`UPnP retries exhausted for ${deviceId}`);
      transition(deviceId, STATE.failed, { retryCount, timer: null });
      return;
    }

    const timer = setTimeout(() => {
      transition(deviceId, STATE.retrying, { timer: null, retryCount });
      void action();
    }, config.subscription.retryDelayMs);

    transition(deviceId, STATE.retrying, {
      retryCount,
      timer,
      serverAddress: serverAddress || record.serverAddress,
    });
  };

  const renewalStagger = (deviceId: string): number => {
    let hash = 0;
    for (const character of deviceId) {
      hash =
        (hash + character.charCodeAt(0)) %
        config.subscription.renewalStaggerSeconds;
    }
    return hash;
  };

  let subscribe: Subscribe;
  let renew: (deviceId: string) => Promise<void>;

  const scheduleRenewal = (deviceId: string): void => {
    const delaySeconds = Math.max(
      1,
      config.subscription.timeoutSeconds -
        config.subscription.renewalMarginSeconds +
        renewalStagger(deviceId),
    );
    const timer = setTimeout(() => {
      transition(deviceId, STATE.renewing, { timer: null });
      void renew(deviceId);
    }, delaySeconds * 1000);

    transition(deviceId, STATE.subscribed, { timer, retryCount: 0 });
  };

  renew = async (deviceId: string): Promise<void> => {
    const device = devices.get(deviceId);
    const record = getRecord(deviceId);
    const serverAddress = record.serverAddress || callbackServerAddress;
    if (!device || !record.sid) {
      logger.error(`Unable to renew UPnP subscription for ${deviceId}`);
      scheduleRetry(
        deviceId,
        () => subscribe(deviceId, serverAddress),
        serverAddress,
      );
      return;
    }

    try {
      const response = await rawRequest({
        url: device.renderingEventUrl,
        method: 'SUBSCRIBE',
        headers: {
          SID: record.sid,
          TIMEOUT: toTimeoutHeader(config.subscription.timeoutSeconds),
        },
      });
      transition(deviceId, STATE.subscribed, {
        sid: getHeaderValue(response.headers, 'sid') || record.sid,
        retryCount: 0,
      });
      logger.debug(`UPnP renewed: ${deviceId}`);
      scheduleRenewal(deviceId);
    } catch (error) {
      logger.error(`Unable to renew UPnP subscription for ${deviceId}`, error);
      scheduleRetry(deviceId, () => renew(deviceId), serverAddress);
    }
  };

  subscribe = async (
    deviceId: string,
    serverAddress = callbackServerAddress,
  ): Promise<void> => {
    const device = devices.get(deviceId);
    if (!device) {
      logger.error(`Unable to subscribe unknown device: ${deviceId}`);
      return;
    }
    if (!serverAddress) {
      scheduleRetry(deviceId, () => subscribe(deviceId), serverAddress);
      return;
    }

    const hubAddress = getHubAddress();
    if (!hubAddress) {
      logger.error('Flic Hub network address is unavailable');
      scheduleRetry(
        deviceId,
        () => subscribe(deviceId, serverAddress),
        serverAddress,
      );
      return;
    }

    callbackServerAddress = serverAddress;
    transition(deviceId, STATE.subscribing, { serverAddress });

    try {
      const response = await rawRequest({
        url: device.renderingEventUrl,
        method: 'SUBSCRIBE',
        headers: {
          CALLBACK: `<http://${hubAddress}:${serverAddress.port}/${encodeURI(deviceId)}>`,
          NT: 'upnp:event',
          TIMEOUT: toTimeoutHeader(config.subscription.timeoutSeconds),
        },
      });
      const sid = getHeaderValue(response.headers, 'sid');
      if (!sid) {
        throw new Error('UPnP subscription response did not include a SID');
      }

      transition(deviceId, STATE.subscribed, {
        sid,
        retryCount: 0,
        serverAddress,
      });
      logger.info(`UPnP subscribed: ${deviceId}`);
      scheduleRenewal(deviceId);
    } catch (error) {
      logger.error(`Unable to subscribe to ${deviceId}`, error);
      scheduleRetry(
        deviceId,
        () => subscribe(deviceId, serverAddress),
        serverAddress,
      );
    }
  };

  const subscribeAll = async (serverAddress: AddressInfo): Promise<void> => {
    callbackServerAddress = serverAddress;
    for (const deviceId of devices.keys()) {
      await subscribe(deviceId, serverAddress);
    }
  };

  const activeCount = (): number => {
    let count = 0;
    for (const subscription of subscriptions.values()) {
      if (subscription.state === STATE.subscribed) {
        count += 1;
      }
    }
    return count;
  };

  return { activeCount, subscribe, subscribeAll };
};
