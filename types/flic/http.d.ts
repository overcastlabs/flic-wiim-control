import type { HttpRequestOptions, HttpResponse } from '../../src/types';

declare module 'http' {
  export function makeRequest(
    options: HttpRequestOptions,
    callback: (error: Error | string | null, response?: HttpResponse) => void,
  ): void;
}
