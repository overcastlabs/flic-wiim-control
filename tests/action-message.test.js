'use strict';

const assert = require('assert');
const { parseActionMessage } = require('../action-message');

// Parses a standard transport command while preserving a device name with spaces.
assert.deepStrictEqual(parseActionMessage('Guest Room Speakers|play'), {
  deviceId: 'Guest Room Speakers',
  command: 'play',
});

// Trims separator whitespace and converts the supported "prev" alias.
assert.deepStrictEqual(parseActionMessage('Guest Room Speakers | prev'), {
  deviceId: 'Guest Room Speakers',
  command: 'previous',
});

// Parses a valid WiiM preset number from the optional command argument.
assert.deepStrictEqual(parseActionMessage('Guest Room Speakers|preset|12'), {
  deviceId: 'Guest Room Speakers',
  command: 'preset',
  preset: 12,
});

// Rejects non-numeric and out-of-range presets before they reach the device.
assert.throws(() => parseActionMessage('Guest Room Speakers|preset|radio'));
assert.throws(() => parseActionMessage('Guest Room Speakers|preset|13'));

// Rejects commands that are not part of the public virtual-device protocol.
assert.throws(() => parseActionMessage('Guest Room Speakers|shuffle'));

console.log('action-message tests passed');
