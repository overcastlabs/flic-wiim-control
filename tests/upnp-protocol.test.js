'use strict';

const assert = require('assert');
const { isCompleteRequest } = require('../event-server');
const {
  createSoapBody,
  normalizeVolume,
  parseDeviceDescription,
  parseEvent,
  resolveUrl,
} = require('../upnp-protocol');

// Converts the Flic 0..1 volume scale to UPnP's 0..100 scale and clamps overflow.
assert.strictEqual(normalizeVolume(0.31), 31);
assert.strictEqual(normalizeVolume(-1), 0);
assert.strictEqual(normalizeVolume(2), 100);

// Resolves a root-relative service URL against the device description origin.
assert.strictEqual(
  resolveUrl('http://192.168.1.10:49152/description.xml', '/upnp/control'),
  'http://192.168.1.10:49152/upnp/control',
);

// Extracts the device identity and service-specific URLs from its description.
const description = `
  <root><device>
    <friendlyName>Office Speakers</friendlyName>
    <modelName>WiiM Pro Receiver</modelName>
    <UDN>uuid:test</UDN>
    <serviceList><service>
      <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
      <controlURL>/upnp/control/rendercontrol1</controlURL>
      <eventSubURL>/upnp/event/rendercontrol1</eventSubURL>
    </service><service>
      <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
      <controlURL>/upnp/control/rendertransport1</controlURL>
      <eventSubURL>/upnp/event/rendertransport1</eventSubURL>
    </service></serviceList>
  </device></root>`;
const device = parseDeviceDescription(
  description,
  'http://192.168.1.10:49152/description.xml',
);
assert.strictEqual(device.name, 'Office Speakers');
assert.strictEqual(
  device.renderingEventUrl,
  'http://192.168.1.10:49152/upnp/event/rendercontrol1',
);
assert.strictEqual(
  device.avTransportControlUrl,
  'http://192.168.1.10:49152/upnp/control/rendertransport1',
);

// Builds an AVTransport SOAP body with the requested action and arguments.
const playBody = createSoapBody(
  'urn:schemas-upnp-org:service:AVTransport:1',
  'Play',
  { InstanceID: 0, Speed: 1 },
);
assert.match(playBody, /<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">/);
assert.match(playBody, /<Speed>1<\/Speed>/);

// Parses a normal RenderingControl notification and decodes its callback path.
const standardEvent = parseEvent(
  'NOTIFY /Office%20Speakers HTTP/1.1\r\n\r\n&lt;Volume channel="Master" val="28"/&gt;',
);
assert.deepStrictEqual(standardEvent, {
  deviceId: 'Office Speakers',
  volume: 28,
});

// Uses SlaveVolume for grouped WiiM events instead of mistaking TimeStamp for volume.
const groupedEvent = parseEvent(
  'NOTIFY /Office%20Speakers HTTP/1.1\r\n\r\n' +
    '&lt;Slave action="volumechange" val="id" ' +
    'SlaveVolume="31" TimeStamp="339189561"/&gt;',
);
assert.strictEqual(groupedEvent.volume, 31);

// Waits for the entire HTTP body specified by Content-Length before parsing a request.
const requestHead =
  'NOTIFY /Office%20Speakers HTTP/1.1\r\nContent-Length: 4\r\n\r\n';
assert.strictEqual(isCompleteRequest(`${requestHead}abc`), false);
assert.strictEqual(isCompleteRequest(`${requestHead}abcd`), true);

console.log('upnp-protocol tests passed');
