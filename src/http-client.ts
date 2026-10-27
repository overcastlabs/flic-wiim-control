import http = require('http');
import { logger } from './logger';
import * as rawHttp from './raw-http';
import type { HttpRequestOptions, HttpResponse } from './types';

const assertSuccess = (
  response: HttpResponse | null | undefined,
): HttpResponse => {
  if (!response || response.statusCode !== 200) {
    const status = response
      ? `${response.statusCode} ${response.statusMessage || ''}`.trim()
      : 'No response';
    throw new Error(`HTTP request failed: ${status}`);
  }
  return response;
};

export const request = (options: HttpRequestOptions): Promise<HttpResponse> => {
  logger.debug('HTTP request:', JSON.stringify(options, null, '  '));

  return new Promise((resolve, reject) => {
    http.makeRequest(options, (error, response) => {
      if (error || !response) {
        reject(
          error instanceof Error
            ? error
            : new Error(String(error || 'No response')),
        );
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

export const rawRequest = async (
  options: HttpRequestOptions,
): Promise<HttpResponse> => {
  logger.debug('Raw HTTP request:', JSON.stringify(options, null, '  '));
  return assertSuccess(await rawHttp.makeRequest(options));
};
