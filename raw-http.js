'use strict';

const net = require('net');

const parseHttpUrl = (url) => {
  const match = /^http:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!match) {
    throw new Error(`Raw HTTP only supports http:// URLs: ${url}`);
  }

  return {
    host: match[1],
    port: match[2] ? Number(match[2]) : 80,
    path: match[3] || '/',
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
 * Sends one HTTP/1.1 request over a raw Flic `net.Socket`.
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
      headers.Host = target.port === 80 ? target.host : `${target.host}:${target.port}`;
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

    const socket = new net.Socket();
    let response = '';
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
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
      result.content = content.slice(0, contentLength || content.length);
      resolve(result);
      socket.destroy();
    };

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
    socket.connect(target.port, target.host, () => {
      socket.write(request);
    });
  });

module.exports = { makeRequest };
