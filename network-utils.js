'use strict';

const network = require('network');

const getHubAddress = () => {
  const state = network.getState();
  const ethernet = state?.dhcp?.ethernet;
  const wifi = state?.dhcp?.wifi;

  if (ethernet?.connected && ethernet.ip) {
    return ethernet.ip;
  }
  if (wifi?.connected && wifi.ip) {
    return wifi.ip;
  }

  return null;
};

module.exports = { getHubAddress };
