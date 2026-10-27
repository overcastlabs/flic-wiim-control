import config from './config';
import type { ActionMessage, TransportCommand } from './types';

const TRANSPORT_COMMANDS = new Set<TransportCommand>([
  'play',
  'pause',
  'stop',
  'next',
  'previous',
]);

const isTransportCommand = (command: string): command is TransportCommand =>
  TRANSPORT_COMMANDS.has(command as TransportCommand);

export const parseActionMessage = (message: unknown): ActionMessage => {
  if (typeof message !== 'string') {
    throw new Error('Action message must be a string');
  }

  const parts = message.split('|').map((part) => part.trim());
  const deviceId = parts[0];
  const requestedCommand = parts[1]?.toLowerCase();
  const command = requestedCommand === 'prev' ? 'previous' : requestedCommand;

  if (!deviceId || !command) {
    throw new Error('Expected action message: <device>|<command>[|<value>]');
  }

  if (isTransportCommand(command) && parts.length === 2) {
    return { deviceId, command };
  }

  if (command === 'preset' && parts.length === 3) {
    const preset = Number(parts[2]);
    if (
      Number.isInteger(preset) &&
      preset >= config.preset.minimum &&
      preset <= config.preset.maximum
    ) {
      return { deviceId, command, preset };
    }
  }

  throw new Error(`Unsupported action message: ${message}`);
};
