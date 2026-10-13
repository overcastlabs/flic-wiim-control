'use strict';

const net = require('net');
const tls = require('tls');

const parseHttpUrl = (url) => {
  const match = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!match) {
    throw new Error(`Invalid HTTP URL: ${url}`);
  }

  const protocol = match[1];
  return {
    protocol,
    host: match[2],
    port: match[3] ? Number(match[3]) : protocol === 'https' ? 443 : 80,
    path: match[4] || '/',
  };
};

const parseResponseHead = (head) => {
  const lines = head.split('\r\n');
  const statusLine = lines.shift();
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);

  if (!statusMatch) {
    throw new Error(`Invalid HTTP response status: ${statusLine || '<empty>'}`);
  }

  const headers = {};
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
const makeRequest = (options) =>
  new Promise((resolve, reject) => {
    let target;
    try {
      target = parseHttpUrl(options.url);
    } catch (error) {
      reject(error);
      return;
    }

    const method = options.method || 'GET';
    const content = options.content || '';
    const headers = Object.assign({}, options.headers || {});
    const hasHeader = (name) =>
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

    let socket;
    let response = '';
    let settled = false;
    let timeoutTimer = null;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finish = () => {
      if (settled) {
        return;
      }

      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      let result;
      try {
        result = parseResponseHead(response.slice(0, headerEnd));
      } catch (error) {
        fail(error);
        socket.destroy();
        return;
      }

      const content = response.slice(headerEnd + 4);
      const contentLength = Number(result.headers['content-length'] || 0);
      if (content.length < contentLength) {
        return;
      }

      settled = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
      }
      result.content = content.slice(0, contentLength || content.length);
      resolve(result);
      socket.destroy();
    };

    const attachListeners = () => {
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
          fail(new Error('Connection ended before a complete HTTP response was received'));
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

module.exports = { makeRequest };
