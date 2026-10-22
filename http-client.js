'use strict';

const http = require('http');
const logger = require('./logger');
const rawHttp = require('./raw-http');

const assertSuccess = (response) => {
  if (!response || response.statusCode !== 200) {
    const status = response
      ? `${response.statusCode} ${response.statusMessage || ''}`.trim()
      : 'No response';
    throw new Error(`HTTP request failed: ${status}`);
  }
  return response;
};

const request = (options) => {
  logger.debug('HTTP request:', JSON.stringify(options, null, '  '));

  return new Promise((resolve, reject) => {
    http.makeRequest(options, (error, response) => {
      if (error || !response) {
        reject(error instanceof Error ? error : new Error(String(error || 'No response')));
        return;
      }

      try {
        resolve(assertSuccess(response));
      } catch (requestError) {
        reject(requestError);
      }
    });
  });
};

const rawRequest = async (options) => {
  logger.debug('Raw HTTP request:', JSON.stringify(options, null, '  '));
  return assertSuccess(await rawHttp.makeRequest(options));
};

module.exports = { request, rawRequest };
