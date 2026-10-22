# WiiM Volume Control for Flic Hub

A Flic Hub Studio module that exposes WiiM players as Flic virtual speakers.
It discovers players with SSDP, expands WiiM multi-room groups, subscribes to
UPnP volume events, and sends RenderingControl actions for Flic Twist changes.

## Features

- Discovers standalone players and group leaders without fixed IP addresses.
- Finds grouped followers through WiiM's local `multiroom:getSlaveList` API.
- Derives the Flic Hub callback address from its active network interface.
- Implements the unsupported HTTP `SUBSCRIBE` verb over raw TCP.
- Renews subscriptions with staggered scheduling and bounded retries.
- Synchronizes volume changes made through other WiiM clients back to Flic.

## Files

- `main.js` — application lifecycle and Flic event wiring.
- `config.js` — user-facing runtime configuration.
- `wiim-discovery.js` — SSDP and grouped-device discovery.
- `wiim-controller.js` — UPnP RenderingControl actions.
- `subscription-manager.js` — subscription state, renewal, and retry logic.
- `event-server.js` — inbound UPnP notification server.
- `upnp-protocol.js` — pure protocol parsing and serialization helpers.
- `http-client.js` — checked wrappers around Flic and raw HTTP clients.
- `raw-http.js` — TCP/TLS HTTP implementation for arbitrary verbs.
- `network-utils.js` — Flic Hub interface-address selection.

## Installation

Copy the JavaScript files and `module.json` into one Flic Hub Studio module.
Create matching `Speaker` virtual devices in the Flic app; their IDs must match
the WiiM friendly names reported during discovery.

Start `main.js` with **Restart after crash** enabled. Successful startup logs the
number of discovered devices followed by one subscription per device.

## Configuration

Runtime constants are centralized in `config.js`. The defaults use callback
port `44445`, ten-minute UPnP subscriptions, and a five-minute health log.

WiiM's local topology API uses a device-generated TLS certificate. Certificate
verification is disabled only for that LAN topology request; UPnP device
control and event traffic use plain HTTP on the device's advertised port.

## Tests

The pure protocol tests run with Node.js and do not access the local network:

```sh
node tests/upnp-protocol.test.js
```

The Flic-specific modules are additionally checked for JavaScript syntax during
development. Runtime integration requires a Flic Hub because its built-in
modules differ from Node.js.
