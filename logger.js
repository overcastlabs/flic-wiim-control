'use strict';

const { debug: debugEnabled } = require('./config');

const write = (level, args) => {
  const values = Array.from(args);
  const first = values.length > 0 ? values.shift() : '';
  console.log(`${level}: ${first}`, ...values);
};

module.exports = {
  info: (...args) => write('INFO', args),
  error: (...args) => write('ERROR', args),
  debug: (...args) => {
    if (debugEnabled) {
      write('DEBUG', args);
    }
  },
};
