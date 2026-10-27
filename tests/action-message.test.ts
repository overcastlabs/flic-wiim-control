import assert from 'node:assert/strict';
import test from 'node:test';
import { parseActionMessage } from '../src/action-message';

// Parses a standard transport command while preserving a device name with spaces.
test('parses a transport command', () => {
  assert.deepStrictEqual(parseActionMessage('Guest Room Speakers|play'), {
    deviceId: 'Guest Room Speakers',
    command: 'play',
  });
});

// Trims separator whitespace and converts the supported "prev" alias.
test('normalizes the previous-command alias', () => {
  assert.deepStrictEqual(parseActionMessage('Guest Room Speakers | prev'), {
    deviceId: 'Guest Room Speakers',
    command: 'previous',
  });
});

// Parses a valid WiiM preset number from the optional command argument.
test('parses a valid preset', () => {
  assert.deepStrictEqual(parseActionMessage('Guest Room Speakers|preset|12'), {
    deviceId: 'Guest Room Speakers',
    command: 'preset',
    preset: 12,
  });
});

// Rejects non-numeric and out-of-range presets before they reach the device.
test('rejects invalid presets', () => {
  assert.throws(() => parseActionMessage('Guest Room Speakers|preset|radio'));
  assert.throws(() => parseActionMessage('Guest Room Speakers|preset|13'));
});

// Rejects commands that are not part of the public virtual-device protocol.
test('rejects unsupported commands', () => {
  assert.throws(() => parseActionMessage('Guest Room Speakers|shuffle'));
});
