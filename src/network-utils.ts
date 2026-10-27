import network = require('network');

export const getHubAddress = (): string | null => {
  const state = network.getState();
  const ethernet = state.dhcp?.ethernet;
  const wifi = state.dhcp?.wifi;

  if (ethernet?.connected && ethernet.ip) {
    return ethernet.ip;
  }
  if (wifi?.connected && wifi.ip) {
    return wifi.ip;
  }

  return null;
};
