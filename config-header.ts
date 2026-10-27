import type { AppConfig } from './src/types';

const WIIM_CONFIG = {
  debug: false,
  healthLogIntervalMs: 5 * 60 * 1000,
  subscription: {
    timeoutSeconds: 10 * 60,
    renewalMarginSeconds: 60,
    renewalStaggerSeconds: 30,
    retryDelayMs: 5000,
    maxRetries: 5,
  },
  ssdp: {
    address: '239.255.255.250',
    port: 1900,
    maximumWaitSeconds: 3,
    retryDelayMs: 750,
    searchTargets: [
      'upnp:rootdevice',
      'urn:schemas-upnp-org:device:MediaRenderer:1',
    ],
  },
  renderingControlService:
    'urn:schemas-upnp-org:service:RenderingControl:1',
  avTransportService: 'urn:schemas-upnp-org:service:AVTransport:1',
  slaveListPath: '/httpapi.asp?command=multiroom:getSlaveList',
  preset: { minimum: 1, maximum: 12 },
} as const satisfies AppConfig;
