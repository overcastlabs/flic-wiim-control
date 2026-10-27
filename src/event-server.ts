import net = require('net');
import { logger } from './logger';
import { parseEvent } from './upnp-protocol';

const EMPTY_OK_RESPONSE =
  'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
const EMPTY_BAD_REQUEST_RESPONSE =
  'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

export const isCompleteRequest = (payload: string): boolean => {
  const headerEnd = payload.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    return false;
  }

  const headers = payload.slice(0, headerEnd);
  const lengthMatch = headers.match(/(?:^|\r\n)CONTENT-LENGTH:\s*(\d+)/i);
  const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0;
  return payload.length >= headerEnd + 4 + contentLength;
};

interface EventServerOptions {
  readonly onVolume: (deviceId: string, volume: number) => void;
}

export const createEventServer = ({
  onVolume,
}: EventServerOptions): net.Server =>
  new net.Server((socket) => {
    let payload = '';
    let handled = false;

    socket.on('error', (error) => logger.error('UPnP event socket error', error));
    socket.on('data', (data) => {
      payload += data.toString();
      if (handled || !isCompleteRequest(payload)) {
        return;
      }
      handled = true;
      logger.debug('UPnP callback:', payload);

      const event = parseEvent(payload);
      if (!event.deviceId) {
        logger.error('UPnP event did not include a device identifier');
        socket.end(EMPTY_BAD_REQUEST_RESPONSE);
        return;
      }

      if (event.volume !== null) {
        onVolume(event.deviceId, event.volume);
      } else {
        logger.debug(`UPnP event contained no volume change: ${event.deviceId}`);
      }
      socket.end(EMPTY_OK_RESPONSE);
    });
  });
