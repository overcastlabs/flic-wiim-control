'use strict';

const config = require('./config');
const { rawRequest } = require('./http-client');
const logger = require('./logger');
const { getHubAddress } = require('./network-utils');
const { getHeaderValue, toTimeoutHeader } = require('./upnp-protocol');

const STATE = Object.freeze({
  idle: 'idle',
  subscribing: 'subscribing',
  subscribed: 'subscribed',
  renewing: 'renewing',
  retrying: 'retrying',
  failed: 'failed',
});

const createSubscriptionManager = ({ devices }) => {
  const subscriptions = new Map();
  let callbackServerAddress = null;

  const getRecord = (deviceId) => {
    if (!subscriptions.has(deviceId)) {
      subscriptions.set(deviceId, {
        state: STATE.idle,
        retryCount: 0,
        sid: null,
        serverAddress: null,
        timer: null,
      });
    }
    return subscriptions.get(deviceId);
  };

  const transition = (deviceId, state, updates = {}) => {
    const record = getRecord(deviceId);
    if (record.timer && updates.timer !== undefined && updates.timer !== record.timer) {
      clearTimeout(record.timer);
    }

    Object.assign(record, updates, { state });
    subscriptions.set(deviceId, record);
    return record;
  };

  const scheduleRetry = (deviceId, action, serverAddress) => {
    const record = getRecord(deviceId);
    const retryCount = record.retryCount + 1;
    if (retryCount > config.subscription.maxRetries) {
      logger.error(`UPnP retries exhausted for ${deviceId}`);
      transition(deviceId, STATE.failed, { retryCount, timer: null });
      return;
    }

    const timer = setTimeout(() => {
      transition(deviceId, STATE.retrying, { timer: null, retryCount });
      action();
    }, config.subscription.retryDelayMs);

    transition(deviceId, STATE.retrying, {
      retryCount,
      timer,
      serverAddress: serverAddress || record.serverAddress,
    });
  };

  const renewalStagger = (deviceId) => {
    let hash = 0;
    for (const character of deviceId) {
      hash =
        (hash + character.charCodeAt(0)) %
        config.subscription.renewalStaggerSeconds;
    }
    return hash;
  };

  let subscribe;
  let renew;

  const scheduleRenewal = (deviceId) => {
    const delaySeconds = Math.max(
      1,
      config.subscription.timeoutSeconds -
        config.subscription.renewalMarginSeconds +
        renewalStagger(deviceId),
    );
    const timer = setTimeout(() => {
      transition(deviceId, STATE.renewing, { timer: null });
      renew(deviceId);
    }, delaySeconds * 1000);

    transition(deviceId, STATE.subscribed, { timer, retryCount: 0 });
  };

  renew = async (deviceId) => {
    const device = devices.get(deviceId);
    const record = getRecord(deviceId);
    const serverAddress = record.serverAddress || callbackServerAddress;
    if (!device || !record.sid) {
      logger.error(`Unable to renew UPnP subscription for ${deviceId}`);
      scheduleRetry(deviceId, () => subscribe(deviceId, serverAddress), serverAddress);
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

  subscribe = async (deviceId, serverAddress = callbackServerAddress) => {
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
      scheduleRetry(deviceId, () => subscribe(deviceId, serverAddress), serverAddress);
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
      scheduleRetry(deviceId, () => subscribe(deviceId, serverAddress), serverAddress);
    }
  };

  const subscribeAll = async (serverAddress) => {
    callbackServerAddress = serverAddress;
    for (const deviceId of devices.keys()) {
      await subscribe(deviceId, serverAddress);
    }
  };

  const activeCount = () => {
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

module.exports = { createSubscriptionManager };
