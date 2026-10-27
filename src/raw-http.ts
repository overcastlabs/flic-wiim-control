import net = require('net');
import tls = require('tls');
import type { HttpRequestOptions, HttpResponse } from './types';

interface HttpTarget {
  readonly protocol: 'http' | 'https';
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

const parseHttpUrl = (url: string): HttpTarget => {
  const match = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!match) {
    throw new Error(`Invalid HTTP URL: ${url}`);
  }

  const protocol = match[1] as HttpTarget['protocol'];
  return {
    protocol,
    host: match[2],
    port: match[3] ? Number(match[3]) : protocol === 'https' ? 443 : 80,
    path: match[4] || '/',
  };
};

const parseResponseHead = (
  head: string,
): Omit<HttpResponse, 'content'> => {
  const lines = head.split('\r\n');
  const statusLine = lines.shift() ?? '';
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(
    statusLine,
  );

  if (!statusMatch) {
    throw new Error(`Invalid HTTP response status: ${statusLine || '<empty>'}`);
  }

  const headers: Record<string, string> = {};
  lines.forEach((line) => {
    const separator = line.indexOf(':');
    if (separator === -1) {
      return;
    }

    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  });

  return {
    statusCode: Number(statusMatch[1]),
    statusMessage: statusMatch[2] || '',
    headers,
  };
};

/**
 * Sends one HTTP/1.1 request over a raw Flic TCP or TLS socket.
 * Intended for verbs, such as SUBSCRIBE, rejected by `http.makeRequest`.
 */
export const makeRequest = (
  options: HttpRequestOptions,
): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    let target: HttpTarget;
    try {
      target = parseHttpUrl(options.url);
    } catch (error) {
      reject(error);
      return;
    }

    const method = options.method || 'GET';
    const content = options.content || '';
    const headers: Record<string, string | number> = { ...options.headers };
    const hasHeader = (name: string): boolean =>
      Object.keys(headers).some((key) => key.toLowerCase() === name);

    if (!hasHeader('host')) {
      const defaultPort = target.protocol === 'https' ? 443 : 80;
      headers.Host =
        target.port === defaultPort ? target.host : `${target.host}:${target.port}`;
    }
    if (!hasHeader('connection')) {
      headers.Connection = 'close';
    }
    if (content && !hasHeader('content-length')) {
      headers['Content-Length'] = Buffer.from(content, 'utf8').length;
    }

    const request = [
      `${method} ${target.path} HTTP/1.1`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      content,
    ].join('\r\n');

    let socket: net.Socket | tls.TLSSocket;
    let response = '';
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finish = (): void => {
      if (settled) {
        return;
      }

      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      let result: Omit<HttpResponse, 'content'>;
      try {
        result = parseResponseHead(response.slice(0, headerEnd));
      } catch (error) {
        fail(error);
        socket.destroy();
        return;
      }

      const responseContent = response.slice(headerEnd + 4);
      const contentLength = Number(result.headers['content-length'] || 0);
      if (responseContent.length < contentLength) {
        return;
      }

      settled = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      resolve({
        ...result,
        content: responseContent.slice(0, contentLength || responseContent.length),
      });
      socket.destroy();
    };

    const attachListeners = (): void => {
      socket.on('data', (data) => {
        // Some Flic Hub firmware exposes Buffer data but not Socket#setEncoding,
        // despite setEncoding being present in newer SDK documentation.
        response += data.toString();
        finish();
      });
      socket.on('error', fail);
      socket.on('end', () => {
        finish();
        if (!settled) {
          fail(
            new Error(
              'Connection ended before a complete HTTP response was received',
            ),
          );
        }
      });
    };

    if (target.protocol === 'https') {
      socket = tls.connect(
        {
          host: target.host,
          port: target.port,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        },
        () => socket.write(request),
      );
      attachListeners();
    } else {
      socket = new net.Socket();
      attachListeners();
      socket.connect(target.port, target.host, () => {
        socket.write(request);
      });
    }

    const timeoutMs = options.timeoutMs || 10000;
    timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      fail(new Error(`HTTP request timed out after ${timeoutMs}ms: ${options.url}`));
      socket.destroy();
    }, timeoutMs);
  });
