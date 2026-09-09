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
| LED timing | frames are sometimes applied **tens of seconds late**; mechanism unknown |
| Found, unexplored | `LMOD`, `COLOR`, `CPOS`, `BGPIC`, `BGCLE`, `QUCMD` |

## Install

```bash
npm install streamdock-m18
```

The driver itself (`streamdock.js` + `models.js`) needs only **node-hid**. `@napi-rs/canvas` is an
optional dependency, used solely by the image helpers and the CLI; you can render key JPEGs any
way you like.

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

Run `npm run dock` with no arguments for the full list.

`npm test` checks the LED zone logic against a fake HID handle, with no hardware attached. That is
as far as automated testing can go here: the device acknowledges nothing it is sent (see
[PROTOCOL.md](PROTOCOL.md)), so the tests can only prove we build the frame we meant to, never that
the hardware applied it.

The 24 addressable LEDs are **two physical groups sharing one index space**: indices 0-21 are the
ring around the unit, and 22-23 are on the front. An animation across all 24 therefore walks off
the ring and finishes on the front, so `led chase` and `led rainbow` take `--zone=ring|front|all`
and default to the ring. The split lives in `ledZones` in `src/device/models.js`; on a different
unit, re-measure it with `led bands`, `led spread <a> <b>` and `led probe`.

The ring's four edges are named zones too (`ledEdges`), so `setLedZoneColors('top', [255, 0, 0])`
works alongside `'ring'` and `'front'`. Index 0 is the middle of the left edge and the indices run
counter-clockwise from the front, 11 per half; no LED sits on a corner. `led corners` checks that
mapping on hardware in one look. See [PROTOCOL.md](PROTOCOL.md) for the per-edge table.

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
