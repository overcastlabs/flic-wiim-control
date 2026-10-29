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

- `src/` — typed application, discovery, protocol, and network source.
- `types/flic/` — hand-authored declarations for Flic Hub runtime modules.
- `config-header.ts` — checked runtime configuration injected into each build.
- `tests/` — protocol and action-message regression tests.
- `scripts/` — release bundling and TypeScript test execution.
- `dist/main.js` — generated, minified Flic Hub release entry point.
- `dist/main.debug.js` — generated, readable entry point for troubleshooting.

## Build

Node.js 20 or later is required for development. Yarn 4.18.1 is pinned in the
repository through `yarnPath`; Corepack or an existing Yarn launcher will use
that version automatically. If the `yarn` command is unavailable, invoke
`.yarn/releases/yarn-4.18.1.cjs` with Node directly. Install the locked
development dependencies and build the release artifacts:

```sh
yarn install --immutable
yarn build
```

The build type-checks the project, bundles all local modules, leaves Flic's
built-in modules as runtime imports, and writes `dist/main.js`,
`dist/main.debug.js`, and `dist/module.json`. The Flic manifest is generated
from `flicHub.name` and `version` in `package.json`.

## Installation

Copy `dist/main.js` and `dist/module.json` into a Flic Hub Studio module. Create
matching `Speaker` virtual devices in the Flic app; their IDs must match the
WiiM friendly names reported during discovery.

Start `main.js` with **Restart after crash** enabled. Successful startup logs the
number of discovered devices followed by one subscription per device.

For readable stack traces during development, upload `dist/main.debug.js` as
`main.js` instead of the minified release artifact.

## Configuration

Runtime constants are centralized in `config-header.ts`. The build preserves
that object, unminified, at the top of the generated `main.js`. Change the source
configuration and rebuild instead of editing generated files in the repository.

The callback server asks the Hub operating system for an available ephemeral
port at startup. The defaults use ten-minute UPnP subscriptions and a
five-minute health log.

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

The type checker and pure protocol tests run with Node.js and do not access the
local network:

```sh
yarn test
```

Run the complete release verification, including both generated bundles, with:

```sh
yarn check
```

## Releases

Create a release from a clean working tree with one of the following commands:

```sh
yarn release patch
yarn release minor
yarn release major
```

The command updates the version in `package.json`, runs the complete release
check, creates a `REL: vX.Y.Z` commit and annotated tag, and pushes both to
`origin`. You can also specify an exact stable version, such as
`yarn release 2.0.0`.

Pushing the tag runs the GitHub release workflow. It verifies that the tag and
package version match, builds the module from a clean checkout, and publishes
`flic-wiim-control-X.Y.Z.zip` containing `main.js` and `module.json`.

To prepare the release commit and tag without pushing them, append `--no-push`:

```sh
yarn release patch --no-push
```

Runtime integration still requires a Flic Hub because its built-in modules
differ from Node.js.
