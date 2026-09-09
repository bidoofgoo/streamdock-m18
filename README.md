# streamdock-m18

Driver and protocol reference for **Mirabox / VSDinside Stream Dock M18** hardware over USB HID,
without the vendor's software.

**[PROTOCOL.md](PROTOCOL.md) is the point of this repository.** It documents the full command set,
verified on real hardware, including the **RGB light strip protocol, which is not published
anywhere else**. Mirabox's own SDK only declares the LED functions; their implementations live in
a precompiled binary.

Works on macOS and Windows through one code path. No driver install, and on macOS no Input
Monitoring grant, because key events arrive on the vendor HID interface rather than the keyboard
one.

Three things live here: the **protocol reference**, a **Node driver** that implements it, and
**`dockd`**, a small daemon that owns the device so apps in any language can share it over a
socket ([jump to it](#sharing-the-dock-between-apps)).

Which document you want:

| | |
|---|---|
| **[CLIENTS.md](CLIENTS.md)** | writing an app that drives the dock. The socket API: commands, events, errors, a worked client |
| **[PROTOCOL.md](PROTOCOL.md)** | writing a driver, or porting to another model. The USB HID wire protocol |
| this file | installing it, the CLI, and how the pieces fit together |

## What is in the protocol reference

| | |
|---|---|
| Output reports | exactly **1024 bytes**, or the device silently discards them |
| Key images | **64x64 JPEG**, no rotation; oversized images corrupt *neighbouring* keys |
| Key numbering | **differs between images and key events** (the rows are reversed) |
| Key events | vendor interface, separate down and up |
| LED strip | **24 addressable LEDs**: `LBLIG`, `SETLB`, `DELED`, RGB order |
| LED layout | **two groups in one index space**: 0-21 ring, 22-23 front |
| Idle revert | fixed by re-asserting brightness every 8s; no other project does this |
| No feedback | the device **acknowledges nothing** it is sent; input reports are key presses only |
| LED timing | a brightness write **wipes the colour frame after it**; send colour first |
| Found, unexplored | `LMOD`, `COLOR`, `CPOS`, `BGPIC`, `BGCLE`, `QUCMD` |

## Install

Not published to npm. Clone it and install the dependencies:

```bash
git clone https://github.com/bidoofgoo/streamdock-m18.git
cd streamdock-m18
npm install
```

The driver itself (`streamdock.js` + `models.js`) needs only **node-hid**. `@napi-rs/canvas` is an
optional dependency used for *rendering* key images: the icon helpers, the CLI's labelled tiles,
and the daemon's `key` command and status screens. Without it you can still push your own JPEGs
(`setKeyImage`, or the daemon's `keyImage`), so it is only required if you want text rendered for
you.

## Usage

```js
import { StreamDock } from 'streamdock-m18';

// watch() survives unplug and re-runs setup on every reconnect
StreamDock.watch(dock => {
  dock.connect();
  dock.setBrightness(80);
  dock.startKeepalive();              // stops the idle revert, and re-asserts the strip
  dock.setLedColor(40, 70, 160);      // all 24 LEDs
  dock.setLedZoneColors('ring', [40, 70, 160]);  // just the ring, front left as it was

  dock.on('key', ({ index, state, aux }) => {
    if (state === 1) console.log(`key ${index} pressed`);   // index 0 = top-left
  });
});
```

Pushing an image, using the bundled helpers:

```js
import { textTile, rotateCanvas, encodeJpeg } from 'streamdock-m18/icons';

const tile = textTile('Hello', { width: 64, height: 64, color: '#1d3557' });
dock.setKeyImage(0, encodeJpeg(rotateCanvas(tile, dock.model.keyRotation), 10240).buf);
```

`setKeyImage` takes a **grid index** (0 = top-left) and handles the raw id mapping. `setKeyImageRaw`
is there if you want to address a raw device id directly.

## CLI

```bash
npm run dock -- info          # HID interfaces and report sizes
npm run dock -- blink         # prove the device responds
npm run dock -- demo          # label every key
npm run dock -- led rainbow   # light strip
npm run dock -- led probe     # map which LED index is on the ring vs the front
npm run dock -- listen        # log key presses as you press them
```

Run `npm run dock` with no arguments for the full list. `npm run dockd` is the daemon, covered
under [sharing the dock](#sharing-the-dock-between-apps); it holds the device exclusively, so stop
it before using these probes.

`npm test` runs three suites with no hardware attached, against a fake HID handle: the LED zone
logic, the daemon's command vocabulary, and the daemon's client hub (line framing, attach state,
error replies). The most valuable assertions are the ones guarding the two key numberings, since
getting those wrong is silent and puts every icon two rows out.

What tests cannot cover here is whether the device *did* what it was told: it acknowledges nothing
it is sent (see [PROTOCOL.md](PROTOCOL.md)), so they prove we build the bytes we meant to and
nothing more. Anything about what the panel or the strip actually shows needs a human looking at
it.

The 24 addressable LEDs are **two physical groups sharing one index space**: indices 0-21 are the
ring around the unit, and 22-23 are on the front. An animation across all 24 therefore walks off
the ring and finishes on the front, so `led chase` and `led rainbow` take `--zone=ring|front|all`
and default to the ring. The split lives in `ledZones` in `src/device/models.js`; on a different
unit, re-measure it with `led bands`, `led spread <a> <b>` and `led probe`.

The ring's four edges are named zones too (`ledEdges`), so `setLedZoneColors('top', [255, 0, 0])`
works alongside `'ring'` and `'front'`. Index 0 is the middle of the left edge and the indices run
counter-clockwise from the front, 11 per half; no LED sits on a corner. `led corners` checks that
mapping on hardware in one look. See [PROTOCOL.md](PROTOCOL.md) for the per-edge table.

## Sharing the dock between apps

`hidapi` grants **exclusive** access to the HID interface, so only one process can hold the dock.
If more than one app needs it, that process has to be a daemon and the apps become clients:

```bash
npm run dockd                 # owns the device, listens on 127.0.0.1:5548
```

| Flag | Default | |
|---|---|---|
| `--port=5548` | 5548 | listening port, and the single-instance lock |
| `--host=127.0.0.1` | localhost | bind address. This is not an internet service; think before widening it |
| `--brightness=80` | 80 | screen brightness applied on connect and on every reconnect |
| `--keepalive-ms=8000` | 8000 | how often to poke the device; 8s is the verified figure |
| `--no-status` | off | do not paint the status screen when no app is driving the panel |
| `--quiet` | off | no logging |

The wire format is **newline-delimited JSON** in both directions, chosen because it needs no
library in any language; `nc 127.0.0.1 5548` is a usable client, and so is anything that can open
a TCP socket. Port 5548 is the dock's USB vendor id, and the port doubles as the single-instance
lock: a second daemon fails to bind and exits rather than fighting for the device.

The daemon owns the two awkward parts, so clients never see them: it re-asserts brightness to stop
the idle revert, and it re-applies device setup after an unplug.

> **Writing a client? See [CLIENTS.md](CLIENTS.md).** Every command and event, the error messages
> you will actually hit, a complete worked client, and the five things that will bite you --
> including two that silently do the wrong thing rather than failing.

With no app connected the daemon paints a status screen rather than leaving the panel blank,
because a blank panel is ambiguous: daemon not running, dock unplugged, app not connected, app
connected but silent, or app crashed mid-paint all look identical. Ownership is tracked separately
for the screen and the strip, so an app that only drives the LEDs keeps the status screen and vice
versa.

### Shipping this inside an app you distribute

The daemon is the right shape for a development machine, and for several apps sharing one dock. It
is the awkward shape for an app you hand to other people, who will not install Node or clone
anything. Two ways out, neither free:

| | |
|---|---|
| **Bundle the daemon** | Compile it to a single executable (Node's SEA, or `bun build --compile`) and launch it from your app. Reuses everything here, and keeps several apps able to share one dock. Costs ~50MB per platform, `node-hid`'s native `.node` binary has to ship beside the executable, and on macOS an unsigned helper that your app launches is what Gatekeeper objects to. |
| **Port the driver** | Reimplement the driver in the app's own language and drop the dependency; in Java, `hid4java` ships the native hidapi builds inside its jar. No subprocess, no port, nothing for users to install. Costs a rewrite, and only one process can then own the dock. |

The rewrite is smaller than it sounds, because what makes this device hard is *knowing* about it,
and that part is written down: the two key numberings, the idle revert, oversized images corrupting
neighbouring keys, the LED geometry, and the fact that nothing is ever acknowledged. The probes in
`tools/dock.js` re-verify a fresh implementation against the same hardware.

**Undecided as of 2026-09-09**, deliberately: the daemon stays separate while the only consumer is
a development machine. Revisit when something actually needs distributing.

### Bringing up an unknown device

`calibrate`, `sizes`, `rotations` and `fit` are the tools that established this device's geometry,
kept because they generalise. They push labelled test tiles so the panel tells you the answer:

```bash
npm run dock -- sizes         # the same tile at 18 sizes, one per key, each labelled
npm run dock -- rotations     # 0/90/180/270; find where the red corner marker lands
npm run dock -- fit           # sizes and rotations together, the decisive single round
npm run dock -- calibrate     # a numbered tile on every raw key id
```

If you have a related model, these plus `PROTOCOL.md` should get you a long way. Add your findings
to `src/device/models.js`, where every field is annotated as verified or inherited.

## Supported hardware

Written against a unit reporting `0x5548:0x1000`, product string `HOTSPOTEKUSB HID DEMO`, which is
an **unlisted OEM variant**: that VID/PID pair appears nowhere in Mirabox's own SDK. It was
identified as an M18 by matching their M18 definition field by field against measurements.

If yours reports different IDs, add it to `models.js` rather than assuming; rebadged units exist.

## Licence and credits

Code is MIT. [PROTOCOL.md](PROTOCOL.md) describes facts about a hardware interface and is intended
for unrestricted use, including by GPL and commercial projects.

This builds on prior reverse engineering by others. **[CREDITS.md](CREDITS.md) records exactly what
came from where**, including a GPLv2 project whose relationship to this MIT one is explained rather
than glossed over.
