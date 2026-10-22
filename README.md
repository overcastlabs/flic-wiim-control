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
- Handles play, pause, stop, next, previous, and preset action messages.

## Files

- `main.js` — application lifecycle and Flic event wiring.
- `action-message.js` — validation for configured Flic action messages.
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

## Media controls and presets

Flic virtual speakers expose volume updates but do not emit dedicated media
button events. Configure a **Message** action in the Flic app using one of these
formats:

```text
Guest Room Speakers|play
Guest Room Speakers|pause
Guest Room Speakers|stop
Guest Room Speakers|next
Guest Room Speakers|previous
Guest Room Speakers|preset|1
```

The device name must exactly match the WiiM friendly name printed during
discovery. Transport messages use the standard UPnP AVTransport service.
Preset messages play an existing WiiM preset through
`MCUKeyShortClick:<number>`; supported slots are 1–12. WiiM's HTTP API does not
provide a way to create, edit, or reorder presets.

## Tests

The pure protocol tests run with Node.js and do not access the local network:

```sh
node tests/action-message.test.js
node tests/upnp-protocol.test.js
```

The Flic-specific modules are additionally checked for JavaScript syntax during
development. Runtime integration requires a Flic Hub because its built-in
modules differ from Node.js.
