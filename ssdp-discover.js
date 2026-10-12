'use strict';

const dgram = require('dgram');

const SSDP_MULTICAST_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_MX = 2;
const SSDP_SEARCH_TARGETS = [
  'ssdp:all',
  'upnp:rootdevice',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
];
const DISCOVERY_TIMEOUT_MS = 5000;

const createSearchMessage = (searchTarget) =>
  Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      `MX: ${SSDP_MX}`,
      `ST: ${searchTarget}`,
      '',
      '',
    ].join('\r\n'),
  );

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

let closed = false;

const closeSocket = () => {
  if (closed) {
    return;
  }
  closed = true;
  try {
    socket.close();
  } catch (error) {
    console.warn('Error closing SSDP socket:', error.message);
  }
};

socket.on('listening', () => {
  const { address, port } = socket.address();
  console.log(`SSDP discovery socket listening on ${address}:${port}`);

  SSDP_SEARCH_TARGETS.forEach((target, index) => {
    const label = index === 0 ? 'initial' : 'additional';
    const message = createSearchMessage(target);
    console.log(`Sending ${label} SSDP M-SEARCH probe for ${target}`);
    socket.send(message, 0, message.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS);
  });

  setTimeout(() => {
    console.log('Sending retry SSDP probes');
    SSDP_SEARCH_TARGETS.forEach((target) => {
      const message = createSearchMessage(target);
      socket.send(message, 0, message.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS);
    });
  }, 750);
});

socket.on('message', (msg, rinfo) => {
  console.log('--- SSDP RESPONSE ---');
  console.log(msg.toString());
});

socket.on('error', (error) => {
  console.error('SSDP socket error:', error);
  closeSocket();
});

setTimeout(() => {
  console.log('Discovery window elapsed; closing socket');
  closeSocket();
}, DISCOVERY_TIMEOUT_MS);

const bindToPort = (port) => {
  try {
    socket.bind(port);
  } catch (error) {
    if (port === 0) {
      throw error;
    }
    console.warn(`Port ${port} unavailable (${error.message}); falling back to ephemeral port`);
    socket.bind(0);
  }
};

bindToPort(SSDP_PORT);
