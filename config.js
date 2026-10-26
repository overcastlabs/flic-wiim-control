'use strict';

module.exports = Object.freeze({
  debug: false,
  healthLogIntervalMs: 5 * 60 * 1000,
  subscription: Object.freeze({
    timeoutSeconds: 10 * 60,
    renewalMarginSeconds: 60,
    renewalStaggerSeconds: 30,
    retryDelayMs: 5000,
    maxRetries: 5,
  }),
  ssdp: Object.freeze({
    address: '239.255.255.250',
    port: 1900,
    maximumWaitSeconds: 3,
    retryDelayMs: 750,
    searchTargets: Object.freeze([
      'upnp:rootdevice',
      'urn:schemas-upnp-org:device:MediaRenderer:1',
    ]),
  }),
  renderingControlService:
    'urn:schemas-upnp-org:service:RenderingControl:1',
  avTransportService: 'urn:schemas-upnp-org:service:AVTransport:1',
  slaveListPath: '/httpapi.asp?command=multiroom:getSlaveList',
  preset: Object.freeze({ minimum: 1, maximum: 12 }),
});
