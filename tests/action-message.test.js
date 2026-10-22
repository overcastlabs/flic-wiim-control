'use strict';

const assert = require('assert');
const { parseActionMessage } = require('../action-message');

assert.deepStrictEqual(parseActionMessage('Guest Room Speakers|play'), {
  deviceId: 'Guest Room Speakers',
  command: 'play',
});
assert.deepStrictEqual(parseActionMessage('Guest Room Speakers | prev'), {
  deviceId: 'Guest Room Speakers',
  command: 'previous',
});
assert.deepStrictEqual(parseActionMessage('Guest Room Speakers|preset|12'), {
  deviceId: 'Guest Room Speakers',
  command: 'preset',
  preset: 12,
});
assert.throws(() => parseActionMessage('Guest Room Speakers|preset|radio'));
assert.throws(() => parseActionMessage('Guest Room Speakers|preset|13'));
assert.throws(() => parseActionMessage('Guest Room Speakers|shuffle'));

console.log('action-message tests passed');
