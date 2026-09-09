# Credits and provenance

All code in this repository was written for this project. No source was copied from any other
implementation. What *was* taken from elsewhere is **knowledge about a hardware protocol**, which
is recorded here in full so anyone can judge for themselves.

## Prior work this builds on

### [rigor789/mirabox-streamdock-node](https://github.com/rigor789/mirabox-streamdock-node) — MIT

Reverse engineered the `CRT` command family for the Mirabox 293 and published a working Node
example. This is where the existence of the protocol came from at all.

Taken: the shape of the command set, the packet layout, the key map concept.

Corrected here: `DIS` is disconnect, not "wake screen"; `BAT` takes a `uint16` length rather than
`uint32`; the report size is model-specific and must be honoured over HID.

### [StreamDoeck/python-streamdoeck](https://github.com/StreamDoeck/python-streamdoeck) — **GPLv2**

A fork of `python-elgato-streamdeck` with unofficial Mirabox support. Its `Mirabox.py` carries the
most accurate published command table, including `CONNECT`, the `ACK` header, and the per-model
geometry that made identifying our device possible.

Taken: corrected command bytes and the initialisation sequence.

**This project is GPLv2 and ours is MIT.** The reasoning: what was taken is a set of command byte
constants, which are facts about a hardware interface rather than creative expression, and the
implementation here was written independently in a different language with a different structure.
Interface facts are generally outside copyright in both US and EU law, and reverse engineering for
interoperability is explicitly protected in the EU. This is a considered judgement, not a legal
opinion. If you take a stricter view, the conservative position would be to treat any derived work
as GPLv2, and that view is not unreasonable.

### [MiraboxSpace/StreamDock-Device-SDK](https://github.com/MiraboxSpace/StreamDock-Device-SDK) — MIT

Mirabox's own SDK. Its per-model definitions identified our unlisted OEM device as an **M18**,
matching every field we had already measured, and declared `hasRGBLed` with `ledCounts = 24`.

The LED wire protocol is **not** in the published source; only the declarations are. The
definitions live in a precompiled transport library that ships in the repository. The commands
`LBLIG`, `SETLB` and `DELED`, and the unexplored `LMOD`, `COLOR`, `CPOS`, `BGPIC`, `BGCLE`,
`QUCMD`, were recovered by disassembling the arm64 macOS build of that library, which is MIT
licensed along with the rest of the repository.

No part of that binary is redistributed here. Only the protocol facts it revealed are described,
in [PROTOCOL.md](PROTOCOL.md).

## What is original here

- The device driver, including the two-direction key numbering, unplug recovery, and the
  brightness keepalive that stops the idle revert. None of these appear in prior work.
- The measured M18 geometry: 64x64 key images at rotation 0, the image and input key maps, the
  aux button ids and their physical order.
- The observation that oversized key images overrun into adjacent key framebuffers.
- The icon rendering helpers and the bring-up CLI (`calibrate`, `sizes`, `rotations`, `fit`),
  which push labelled test tiles so an unknown panel reports its own geometry.
- The **RGB strip wire protocol** as documented (the vendor ships only declarations plus a
  precompiled binary), and the measured discovery that its 24 LEDs are two physically separate
  groups in one index space, with the full ring geometry: origin, direction and per-edge ranges.
- The observation that `SETLB` frames are sometimes applied tens of seconds late, and that the
  device acknowledges nothing at all, which is what makes that hard to diagnose.
- `dockd` and its JSON protocol, which exists because `hidapi` grants exclusive access and several
  apps therefore cannot share the device without one process owning it.

## Licence

Code: MIT, see [LICENSE](LICENSE).

[PROTOCOL.md](PROTOCOL.md) documents facts about a hardware interface and is intended for
unrestricted use, including by GPL projects, commercial ones, and the vendor.
