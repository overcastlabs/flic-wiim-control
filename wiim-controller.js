'use strict';

const config = require('./config');
const { rawRequest, request } = require('./http-client');
const logger = require('./logger');
const { createSoapBody, splitLocation } = require('./upnp-protocol');

const TRANSPORT_ACTIONS = Object.freeze({
  play: Object.freeze({ action: 'Play', properties: { InstanceID: 0, Speed: 1 } }),
  pause: Object.freeze({ action: 'Pause', properties: { InstanceID: 0 } }),
  stop: Object.freeze({ action: 'Stop', properties: { InstanceID: 0 } }),
  next: Object.freeze({ action: 'Next', properties: { InstanceID: 0 } }),
  previous: Object.freeze({ action: 'Previous', properties: { InstanceID: 0 } }),
});

const createController = ({ devices }) => {
  const performAction = (deviceId, serviceType, controlUrl, action, properties) => {
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

  const setVolume = (deviceId, volume) =>
    performAction(
      deviceId,
      config.renderingControlService,
      (device) => device.renderingControlUrl,
      'SetVolume',
      {
        InstanceID: 0,
        Channel: 'Single',
        DesiredVolume: volume,
      },
    ).catch((error) => {
      logger.error(`Unable to set volume for ${deviceId}`, error);
    });

  const sendTransportCommand = (deviceId, command) => {
    const definition = TRANSPORT_ACTIONS[command];
    if (!definition) {
      return Promise.reject(new Error(`Unsupported transport command: ${command}`));
    }

    return performAction(
      deviceId,
      config.avTransportService,
      (device) => device.avTransportControlUrl,
      definition.action,
      definition.properties,
    ).catch((error) => {
      logger.error(`Unable to send ${command} to ${deviceId}`, error);
    });
  };

  const playPreset = (deviceId, preset) => {
    if (
      !Number.isInteger(preset) ||
      preset < config.preset.minimum ||
      preset > config.preset.maximum
    ) {
      return Promise.reject(
        new Error(
          `Preset must be between ${config.preset.minimum} and ${config.preset.maximum}`,
        ),
      );
    }

    const device = devices.get(deviceId);
    const location = device && splitLocation(device.location);
    if (!device || !location) {
      return Promise.reject(new Error(`Unknown virtual device: ${deviceId}`));
    }

    const host = location.host.replace(/:\d+$/, '');
    return rawRequest({
      url: `https://${host}/httpapi.asp?command=MCUKeyShortClick:${preset}`,
      method: 'GET',
      rejectUnauthorized: false,
      timeoutMs: 10000,
    }).catch((error) => {
      logger.error(`Unable to play preset ${preset} on ${deviceId}`, error);
    });
  };

  return { playPreset, sendTransportCommand, setVolume };
};

module.exports = { createController };
