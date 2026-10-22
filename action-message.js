'use strict';

const { preset: presetConfig } = require('./config');

const TRANSPORT_COMMANDS = new Set([
  'play',
  'pause',
  'stop',
  'next',
  'previous',
]);

const parseActionMessage = (message) => {
  if (typeof message !== 'string') {
    throw new Error('Action message must be a string');
  }

  const parts = message.split('|').map((part) => part.trim());
  const deviceId = parts[0];
  const command = parts[1]?.toLowerCase() === 'prev'
    ? 'previous'
    : parts[1]?.toLowerCase();

  if (!deviceId || !command) {
    throw new Error('Expected action message: <device>|<command>[|<value>]');
  }

  if (TRANSPORT_COMMANDS.has(command) && parts.length === 2) {
    return { deviceId, command };
  }

  if (command === 'preset' && parts.length === 3) {
    const preset = Number(parts[2]);
    if (
      Number.isInteger(preset) &&
      preset >= presetConfig.minimum &&
      preset <= presetConfig.maximum
    ) {
      return { deviceId, command, preset };
    }
  }

  throw new Error(`Unsupported action message: ${message}`);
};

module.exports = { parseActionMessage };
