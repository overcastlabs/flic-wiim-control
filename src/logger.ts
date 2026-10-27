import config from './config';

const write = (level: string, args: readonly unknown[]): void => {
  const values = Array.from(args);
  const first = values.length > 0 ? values.shift() : '';
  console.log(`${level}: ${String(first)}`, ...values);
};

export const logger = {
  info: (...args: unknown[]): void => write('INFO', args),
  error: (...args: unknown[]): void => write('ERROR', args),
  debug: (...args: unknown[]): void => {
    if (config.debug) {
      write('DEBUG', args);
    }
  },
};
