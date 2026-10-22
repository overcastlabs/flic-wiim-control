'use strict';

const config = require('./config');
const { request } = require('./http-client');
const logger = require('./logger');
const { createSoapBody } = require('./upnp-protocol');

const createController = ({ devices }) => {
  const performAction = (deviceId, action, properties) => {
    const device = devices.get(deviceId);
    if (!device) {
      return Promise.reject(new Error(`Unknown virtual device: ${deviceId}`));
    }

    return request({
      url: device.controlUrl,
      method: 'POST',
      headers: {
        SOAPACTION: `"${config.renderingControlService}#${action}"`,
        'CONTENT-TYPE': 'text/xml; charset="utf-8"',
      },
      content: createSoapBody(action, properties),
    });
  };

  const setVolume = (deviceId, volume) =>
    performAction(deviceId, 'SetVolume', {
      InstanceID: 0,
      Channel: 'Single',
      DesiredVolume: volume,
    }).catch((error) => {
      logger.error(`Unable to set volume for ${deviceId}`, error);
    });

  return { setVolume };
};

module.exports = { createController };
