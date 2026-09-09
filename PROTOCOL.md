# Stream Dock M18 (and relatives): USB HID protocol

A reverse-engineered reference for driving Mirabox / VSDinside **Stream Dock M18** hardware
directly over USB HID, without the vendor's software.

Everything here was verified on real hardware unless explicitly marked otherwise. Where a claim is
inherited from another project rather than measured, it says so.

**This document is a description of facts about a hardware interface, published so that other
implementations can interoperate. Treat it as public domain.** The accompanying code is MIT; see
[CREDITS.md](CREDITS.md) for what came from where.

---

## 1. Identifying the device

The unit this was written against reports:

| Field | Value |
|---|---|
| USB vendor string | `HOTSPOTEKUSB` |
| USB product string | `HOTSPOTEKUSB HID DEMO` |
| VID:PID | `0x5548:0x1000` |
| Layout | 15 LCD keys (3 rows x 5 cols) + 3 plain buttons |

**This VID/PID pair appears nowhere in Mirabox's own SDK.** PID `0x1000` is listed there as
`N1EN`, but against VID `0x6603`, and the N1 is a 20-key device with rotary encoders. So this is
an unlisted OEM variant, consistent with the generic `HID DEMO` product string.

It was identified as an **M18** by matching Mirabox's SDK definition field by field against
measurements: 15 keys, the same image key map, the same three aux button ids, rotation 0, no flip,
`hasRGBLed` with `ledCounts = 24`. Every field agreed.

**Do not match on VID/PID alone** if you are supporting these devices generally. Rebadged OEM
units exist with IDs absent from the vendor's own tables.

## 2. HID interfaces

The device exposes two:

| Interface | Usage page | Usage | Purpose |
|---|---|---|---|
| 1 | `0x0001` | `0x0006` | a standard **keyboard**. This is what types keystrokes when no software is running. Ignore it. |
| 0 | `0xFFA0` | `0x01`, `0x02` | **vendor defined**. Images out, key events in. This is the one to open. |

Everything below happens on interface 0.

### No special permissions are needed

On macOS this opens with no Input Monitoring grant and no driver install; HID devices bind to the
built-in `IOHIDFamily`. Key events arrive on the vendor interface, so the keyboard interface never
has to be touched, which is what would require the permission.

**libusb is not a viable transport on macOS.** The OS HID driver claims HID-class interfaces, so
`claim()` fails. Use an HID API (hidapi, node-hid, IOHIDManager). One HID code path covers macOS,
Windows and Linux.

## 3. Report sizes

From the report descriptor of interface 0:

```
06 a0 ff   Usage Page (Vendor 0xFFA0)
09 01      Usage (0x01)
a1 01      Collection (Application)
09 02        Usage (0x02)
a1 00        Collection (Physical)
06 a1 ff       Usage Page (Vendor 0xFFA1)
09 03 09 04    Usage 0x03, 0x04
75 08          Report Size  (8 bits)
96 00 02       Report Count (0x0200 = 512)
81 02          INPUT    <-- input reports are exactly 512 bytes
09 05 09 06    Usage 0x05, 0x06
75 08
96 00 04       Report Count (0x0400 = 1024)
91 02          OUTPUT   <-- output reports are exactly 1024 bytes
c0 c0
```

- **OUTPUT reports: exactly 1024 bytes**
- **INPUT reports: exactly 512 bytes**
- **No report IDs**

> **The single most important gotcha.** An output report that is not exactly 1024 bytes is
> *silently discarded*. No error, no acknowledgement, nothing happens. Projects that drive these
> devices over raw libusb interrupt transfers can use any length they like, because libusb does
> not enforce report sizes; over HID you must pad to the declared size. Different models declare
> different sizes (the 293 uses 512), so read the descriptor rather than assuming.

Since there are no report IDs, hidapi-style APIs expect a leading `0x00` byte that is stripped
before transmission, so a write is **1025 bytes**: `0x00` followed by the 1024 byte report.

## 4. Packet format

```
[0x00]              report ID byte (stripped by hidapi; omit if your API handles this)
[43 52 54 00 00]    "CRT\0\0" magic prefix
[command bytes]
[payload]
[zero padding]      out to exactly 1024 bytes after the report ID
```

## 5. Commands

All are preceded by the `CRT\0\0` prefix.

| Name | Bytes | Payload | Purpose |
|---|---|---|---|
| `CONNECT` | `43 4f 4e 4e 45 43 54` | none | **connect / ping. Required before anything else works.** |
| `DIS` | `44 49 53` | none | **disconnect.** Puts the panel to sleep. |
| `HAN` | `48 41 4e` | none | hang up; sent on close |
| `STP` | `53 54 50` | none | commit / refresh; ends a transfer |
| `LIG` | `4c 49 47 00 00` | 1 byte | screen brightness, **0-100** (a percentage, not 0-255) |
| `CLE` | `43 4c 45 00 00 00` | 1 byte | clear key image; `0xff` clears all |
| `CLOSE` | `43 4c 45 00 44 43` | none | close |
| `BAT` | `42 41 54 00 00` | `u16be size`, `u8 key` | begin key image; JPEG follows as raw 1024 byte pages |
| `LOG` | `4c 4f 47` | `u32be size`, `u8 screen` | begin boot splash; raw pages follow |
| `LBLIG` | `4c 42 4c 49 47` | 1 byte | **LED strip brightness**, 0-100 |
| `SETLB` | `53 45 54 4c 42` | 3 bytes per LED | **LED strip colours** |
| `DELED` | `44 45 4c 45 44` | none | **reset LED strip** |

### Commands seen but not explored

Present in the vendor's transport library string table, purpose inferred from the name only:

`LMOD`, `COLOR`, `CPOS`, `BGPIC`, `BGCLE`, `QUCMD`

`BGPIC` / `BGCLE` look like background image set and clear. `QUCMD` looks like a query.

`QUCMD` was tried on 2026-09-09, with no argument and with a single `0x00` / `0x01` argument, while
listening for input reports for 2.5s after each. **Nothing came back in any form.** Either it needs
an argument shape we did not guess, or it answers somewhere other than the input endpoint. The
others are untried, and `LMOD` / `COLOR` / `CPOS` / `BGPIC` / `BGCLE` may all change device state,
so they want a deliberate session rather than a casual poke.

### Initialisation

```
DIS  >  CONNECT  >  CLE 0xff  >  STP
```

> **`DIS` means disconnect, not wake.** At least one published implementation labels it
> `wakeScreen`. Sending it alone leaves the panel dark, and sending it before every command keeps
> the device permanently disconnected. The leading `DIS` in the sequence above is deliberate: it
> resets a half-open session left by a process that did not close cleanly.

### The device does not acknowledge commands

Some implementations expect an `ACK\0\0OK\0` (`41 43 4b 00 00 4f 4b 00`) input report. **This
device sends nothing at all** in response to `CONNECT`, `DIS`, `HAN`, `STP`, `LIG` or `CLE`. Code
that waits for an acknowledgement will hang forever. The `ACK` header does appear, but only as the
prefix of key press reports.

MEASURED 2026-09-09, to put a number on it: 180 `SETLB` frames over 90s, plus `CONNECT`, `LBLIG`,
`STP` and `QUCMD`, produced **zero input reports**.

This is the most awkward fact about the protocol, and it shapes how anything here can be debugged.
There is no completion, no error and no status, so **a write tells you only that the OS accepted
the report**: `hid_write` returned 1025 bytes in 0.5-3.8ms every single time, including for frames
that visibly had not been applied yet. Nothing on the host can distinguish an applied frame from a
queued or ignored one, so diagnosing the display or the strip needs a human looking at the device.
Budget for that, and prefer probes that keep re-sending over probes that paint once and ask.

## 6. Key images

| Property | Value |
|---|---|
| Format | JPEG |
| Size | **64 x 64** |
| Rotation | **none** (0 degrees) |
| Flip | none |
| Max bytes | 10240 (inherited figure; never approached in practice, 64x64 lands at 2-4 KB) |

Sequence: `BAT <u16be length> <key id>`, then the JPEG as raw 1024 byte pages with no prefix,
then `STP`.

> **Oversized images are not scaled. They overrun into the next key's framebuffer.** A 150x150
> tile visibly smears across several keys below its target. The device blits into a fixed per-key
> buffer with no bounds checking, so an image that is too large corrupts keys you never wrote to.
> Always resize to exactly 64x64.

Size and rotation vary by model: the 293 uses 100x100 rotated 180, the N3 64x64 rotated -90.
Do not assume one model's geometry applies to another.

## 7. Keys

### Two different numberings, one per direction

The device numbers the same physical key differently depending on which way the data flows:

|  | top row | middle row | bottom row |
|---|---|---|---|
| **images out** | `0x0b`-`0x0f` | `0x06`-`0x0a` | `0x01`-`0x05` |
| **key events in** | `0x01`-`0x05` | `0x06`-`0x0a` | `0x0b`-`0x0f` |

Left to right within each row, in both cases.

> **The rows are reversed between the two directions.** Collapsing these into one table guarantees
> being wrong in one direction, and the symptom is confusing: every icon appears on exactly the
> right key while every press triggers the action two rows away.
>
> **The middle row is identical in both numberings**, so any test that only exercises the middle
> row passes regardless of which map is used.

### Aux buttons

The three plain buttons report on the same vendor interface, with the same event format:

| Button | Raw id |
|---|---|
| left | `0x25` |
| middle | `0x30` |
| right | `0x31` |

These sit well outside the `0x01`-`0x0f` grid range, so they can never be confused with a screen
key.

### Key event format

512 byte input reports:

| Offset | Meaning |
|---|---|
| 0-7 | `ACK\0\0OK\0` header |
| 9 | raw key id |
| 10 | state: **1 = down, 0 = up** |

**Separate press and release events are delivered**, which makes press-and-hold behaviour
possible. Not all models do this: the 293S fires only on release, and its library fakes a
press/release pair to compensate.

## 8. The RGB light strip

The M18 has **24 individually addressable LEDs**.

| Command | Bytes after prefix | Payload |
|---|---|---|
| `LBLIG` | `4c 42 4c 49 47` | 1 byte, brightness 0-100 |
| `SETLB` | `53 45 54 4c 42` | 3 bytes per LED, `[r, g, b]`, 24 LEDs = 72 bytes |
| `DELED` | `44 45 4c 45 44` | none |

**Channel order is RGB.** Verified: `(255, 0, 0)` produces red, so there is no GRB swap.

The vendor SDK's `setLedColor` (uniform) and `setSingleLedColor` (per-LED) are the **same `SETLB`
command**; the former simply repeats one triple. The strip is fully addressable, not a single zone.

Other models declaring LEDs in the vendor SDK: Mini (12), N4Pro (4), XL (6).

### The 24 are two physical groups, not one ring

`SETLB` addresses 24 LEDs in one flat index space, but they are not all in the same place:

| Indices | Where | Count |
|---|---|---|
| 0-21 | the ring around the unit | 22 |
| **22-23** | **the front of the unit** | **2** |

VERIFIED 2026-09-09 by painting the strip in coloured bands of consecutive indices, reading off
where each band appeared, then separating the final band with one distinct colour per index.
All 24 are fitted; every index lit.

Consequences for anything animating the strip:

- A chase or hue sweep over all 24 indices looks broken, because it leaves the ring at index 21
  and finishes on the front. Animate `ring` (or `front`) as a zone, not the raw strip.
- A zone write still has to send a full 24 LED frame, since `SETLB` has no partial form. The
  driver keeps the last frame sent and merges zone writes into it (`setLedZoneColors`), so
  animating the ring leaves the front alone.

### Ring geometry

Index 0 is the **middle of the left edge**, not a corner, and the indices ascend **counter-clockwise
seen from the front**: down the left edge, right along the bottom, up the right edge, left along
the top.

| Indices | Edge | Count |
|---|---|---|
| 20, 21, 0, 1, 2 | left (wraps past index 0) | 5 |
| 3 - 8 | bottom | 6 |
| 9, 10, 11, 12, 13 | right | 5 |
| 14 - 19 | top | 6 |

The ring is symmetric about index 0: 11 LEDs per half, and index 11 sits exactly opposite index 0
in the middle of the right edge. **No LED sits on a corner** - the corners fall in the gaps between
2/3, 8/9, 13/14 and 19/20 - so an effect cannot land an LED on a corner, and cannot start at one
by starting at index 0.

VERIFIED 2026-09-09: the lower half by lighting indices in distinct colours and reading off their
positions, the upper half by `led corners`, which alternates the four edges red and blue so that
every corner becomes a colour boundary. All four boundaries landed on corners.

Reproduce on another unit with `npm run dock -- led bands`, then `led spread <a> <b>` on whichever
band straddles a boundary, and `led corners` to check all four at once; `led probe` walks all 24
one at a time if the bands are unclear.

### `SETLB` frames are sometimes applied late

Observed twice on 2026-09-09, and recorded because it cost several rounds of measurement, not
because the mechanism is understood. A frame is accepted with no error, the strip does not change,
and then **seconds to tens of seconds later the frame appears** with nothing further sent. It is a
delay, not a loss.

That single behaviour accounts for a run of confusing observations, all of which looked like
different bugs at the time:

- a frame that seemed ignored while a later, simpler one seemed to work (the later one was quick;
  the earlier one arrived after we had stopped looking);
- a mapping that seemed wrong because the ring stayed dark;
- an unplug and replug that seemed to fix it.

Two earlier explanations are therefore **withdrawn**, and are recorded here only so nobody
re-derives them: that bursts of back-to-back `SETLB` frames are dropped (disproved by `led chase`,
which sends 22 frames a pass and has always worked), and that the strip stops accepting per-LED
frames after a USB bus drop until a physical replug (better explained by the delay).

What it means in practice:

- **A strip that has not changed is not evidence of a wrong index map.** Wait, look again, and
  only then suspect the mapping.
- Assert `LBLIG` before trusting a frame at all, since brightness 0 produces the identical
  symptom for a completely different reason.
- An interactive probe should keep re-sending or alternating frames rather than painting once and
  asking a question, so a late frame cannot be mistaken for a wrong one.
- **Re-assert the strip periodically**, the same way the screen needs `LIG` to stop reverting.
  `startKeepalive()` re-sends `LBLIG` and the last `SETLB` frame on every tick, which bounds how
  stale the strip can be to one interval. That is a mitigation for the symptom, chosen because
  it costs one ~1ms write per tick and cannot make anything worse; it is not a fix, and it is not
  evidence for any particular mechanism. Re-sending a frame the strip already shows is **not
  visible**: verified 2026-09-09 with a static frame re-sent every 2s, with no flicker.

The shape of the guess, for whoever gets further than we did: the screen has a watchdog that
reverts it to the stock display when the host goes quiet, and `LIG` every 8s demonstrably stops
that. If the strip has a watchdog of the same kind, then a host that never re-asserts the strip
looks dead on that channel, and the firmware is free to deprioritise or defer it. That would
explain why every late frame we saw happened around an idle, reverted or freshly reconnected
panel, and never during 180 consecutive frames with a session actively writing. It remains a
guess: nothing on the host can observe the strip, so this is a hypothesis that fits, not a
finding.

## 9. Two behaviours worth designing around

### It reverts to its stock screen when idle

The panel falls back to its built-in display after a period of host silence.

| Poke | Interval | Result |
|---|---|---|
| nothing | - | reverts |
| `STP` refresh | 10s | still reverts |
| **`LIG`, re-asserting current brightness** | **8s** | **stays put** |

Re-asserting brightness every 8 seconds fixes it completely. Presumably the backlight is what
sleeps, so poking it directly is the targeted fix. **No reference implementation sends any
keepalive**, so this is not documented anywhere else.

### It occasionally drops off the USB bus

Observed twice in one evening: the device vanished from the OS device tree entirely, surfacing as
a read error (`hid_read_timeout: error waiting for more data`). Cause unknown; it happened both
with and without a keepalive running, so keepalives are not implicated.

Design for it rather than against it:

- Treat a read error as a **disconnect**, not a fatal error. hidapi's read loop stays dead after
  an unplug, so an unhandled error takes the whole application down.
- Poll for the device and **re-run setup on every reconnect**, so the board redraws itself.

Also note **hidapi grants exclusive access**: a second process cannot open the device while the
first holds it. Treat "device busy" as retryable rather than fatal.

## 10. Provenance

The `CRT` command family is documented in existing community projects (see
[CREDITS.md](CREDITS.md)). Independently verified here, with several corrections.

**The LED protocol is not documented anywhere public that I could find.** Mirabox's SDK only
*declares* the LED functions; the definitions live in a precompiled transport library. That
library ships in their repository, including an arm64 macOS build with symbols intact.
Disassembling `Transport::setLedBrightness`, `::setLedColor`, `::setSingleLedColor` and
`::resetLedColor` showed each building a 10 byte header and passing it to the same transport as
every other command. The string table in the same binary yielded the full command list, including
the six unexplored commands above.

No opcode guessing against firmware was involved.
