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
| Firmware | `V3.VSDM18_HXJDF.02.020`, as shown by the vendor's VSD Craft app |

All measurements in this document were taken on that firmware version. Other versions may behave
differently. On 2026-09-26 the vendor app reported it as the latest version available.

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
| `APPNEW` | `41 50 50 4e 45 57` | none | **reboot into the bootloader's upgrade mode**, see below |

### `APPNEW`: reboot into upgrade mode

VERIFIED 2026-09-26 on hardware. The dock drops off the bus and within a few seconds comes back
as a different device, **`0x33C3:0x8899`**. That is the HID upgrade mode of the ArtInChip D13x
SoC inside. Nothing is written to flash. The firmware only records a reboot reason and resets,
and a plain unplug and replug boots the normal firmware again.

This is the command the vendor's firmware updater sends before flashing. In upgrade mode the dock
speaks ArtInChip's upgrade protocol, not this one. The
[firmware backup](https://github.com/bidoofgoo/streamdock-m18-firmware/blob/main/BACKUP.md) in
streamdock-m18-firmware uses it to read the whole flash.

### Commands seen but not explored

Present in the vendor's transport library string table, purpose inferred from the name only:

`LMOD`, `COLOR`, `CPOS`, `BGPIC`, `BGCLE`, `QUCMD`

`BGPIC` / `BGCLE` look like background image set and clear. `QUCMD` looks like a query.

`QUCMD` was tried on 2026-09-09, with no argument and with a single `0x00` / `0x01` argument, while
listening for input reports for 2.5s after each. **Nothing came back in any form.** Either it needs
an argument shape we did not guess, or it answers somewhere other than the input endpoint. The
others are untried, and `LMOD` / `COLOR` / `CPOS` / `BGPIC` / `BGCLE` may all change device state,
so they want a deliberate session rather than a casual poke.

### `MOD`: tried, not useful on the M18

`MOD` (`4d 4f 44 00 00 <0x30+n>`) is not in the vendor table above. A driver for the same
`5548:1000` id ([stevemurr/streamdock](https://github.com/stevemurr/streamdock)) documents it as a
mode switch (1 = keyboard, 2 = calc, 3 = software), with keyboard as the boot default. TRIED
2026-09-25 on the M18:

- `MOD 1` makes the device drop off USB and re-enumerate with the same interfaces, back on its
  stock screen. After that, keys report nowhere, neither on interface 0 nor as keystrokes on
  interface 1.
- `MOD 3` sent to a freshly plugged device does nothing visible. The stock screen stays, and no key
  reports arrive.
- A freshly plugged device sends no key reports at all until `DIS > CONNECT`. That handshake, not
  `MOD`, is what turns reporting on, so the driver does not send `MOD`.

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

### One key at a time

> **The firmware reports one key at a time. There is no rollover, and chords are impossible.**
> While any key is held, every other key is invisible, the three aux buttons included.

VERIFIED 2026-09-25 on hardware with `dock.js listen --raw`:

- **Second key pressed and released while the first is held:** no input report at all, not even
  after the first is released. It is lost, not queued. Tried across a row (`0x01` + `0x05`), across
  the grid (`0x01` + `0x0f`) and grid + aux, with the first key held for up to 8s.
- **Second key still held when the first is released:** it is reported about 40ms after the first
  one's up, which is a few scan cycles. So the firmware rescans and picks it up, but only once it
  is the only key down.
- **A held key sends no repeats**, just one down and one up however long it is held.
- **Rapid tapping is clean:** 12 taps in under 2s on one key, strictly alternating down/up, with no
  drops and no bounce. The shortest gap was 40ms. Timestamps land on a 10ms grid, which suggests a
  10ms scan.

This fits the report format, which has room for exactly one key id. It is not something the
driver can work around, since no report is ever sent for the hidden key.

**It is a property of the stock firmware, not of the hardware.** The measurements above were
taken on `V3.VSDM18_HXJDF.02.020`. Reading the key scan in the vendor's public
`V3.VSDM18.02.015` image confirms the mechanism, and it is stricter than "report the first key":

- The 15 display keys are a **3 x 5 matrix**, scanned one row at a time by a dedicated thread
  every 30ms.
- As soon as a row shows a pressed key, **the scan waits on that key until it is released**,
  rechecking every 10ms, before it looks at anything else. Keys pressed meanwhile are never
  scanned, which is why they are lost rather than queued. The 10ms recheck matches the 10ms grid
  in the timestamps.
- The column decode only recognises one pressed column per row.

So different firmware could report chords. Whether they would be reliable depends on the matrix
having a diode per key, which the firmware cannot tell us. Without diodes, three keys forming a
rectangle "ghost" a fourth.

Also ruled out:

- **The keyboard interface (interface 1).** It sends no keystrokes in normal operation. Nothing
  appears in a text editor when keys are pressed.
- **Switching to keyboard mode with `MOD 1`**, in the hope that it behaves like a real keyboard
  with rollover. It does not: the keys then report nowhere. See `MOD` in §5.

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

### `LBLIG` wipes the `SETLB` frame that follows it

**MECHANISM FOUND 2026-09-09**, replacing an earlier entry here that recorded the symptom as
"frames are sometimes applied late" and admitted the cause was not understood. It is not a delay
and not a loss: a brightness write and a colour frame sent back to back **fight each other**.

The device applies `LBLIG` asynchronously, re-rendering the strip from its own buffer, and that
render **overwrites any `SETLB` frame that arrived in between**. Send a colour immediately after a
brightness write and it appears for a fraction of a second and is then wiped.

How it was measured, since nothing on the host can see the strip:

- Six writes alternating method, each a different colour, held 6s, keepalive off so nothing could
  rescue a lost frame. Colour-only writes all appeared; every brightness-then-colour write
  vanished. Seen: red, blue, magenta. Not seen: green, yellow, cyan.
- Then the same with a gap after the brightness: **0ms flashes and is wiped, 150ms survives,
  500ms survives.** So the colour is genuinely accepted, and it is the brightness render landing
  afterwards that destroys it.

This one behaviour accounts for the whole run of confusing observations previously listed here,
all of which looked like separate bugs:

- a frame that seemed ignored while a later, simpler one worked (the simpler one sent no
  brightness);
- a mapping that seemed wrong because the ring stayed dark;
- a colour that appeared "seconds late" with nothing further sent (it was the next keepalive tick
  re-asserting the frame, on a tick where the timing happened to work out);
- an unplug and replug that seemed to fix it.

**Withdrawn, so nobody re-derives them:**

- That bursts of back-to-back `SETLB` frames are dropped. Disproved by `led chase`, which sends 22
  frames a pass and has always worked -- it never touches brightness.
- That the strip stops accepting per-LED frames after a USB bus drop until a physical replug.
- That the strip has an idle watchdog like the screen's, deprioritising a channel the host has not
  re-asserted. It fitted the evidence and was wrong. Every "late" frame happened around an idle or
  freshly reconnected panel because those are exactly the moments something sets brightness.
- **That you should "assert `LBLIG` before trusting a frame".** This was the advice here before,
  and it is the direct cause of the symptom it was meant to rule out. Brightness 0 does produce an
  identical dark ring, so check it -- but check it ONCE, well before the colours, never
  immediately preceding them.

What it means in practice:

- **Do not re-send a brightness that has not changed.** `setLedBrightness()` now skips a write
  that changes nothing (`{ force: true }` overrides), because the natural way to write a caller --
  set your brightness, then set your colour -- was silently the broken one. Two callers in this
  repo did exactly that and lost every colour they sent.
- If brightness and colour must both change, **send the colour first**. The render reads the
  device's own frame buffer, so a colour already sitting in it is picked up rather than
  overwritten. Nothing is lost and no delay is needed anywhere. VERIFIED 2026-09-09: four
  colour-then-brightness pairs sent back to back, all four applied.
  Only if a caller cannot know the colour in advance -- `dock.js led` arms brightness before any
  mode has painted, deliberately, so a dark strip can be told from a wrong map -- does it need
  the other order plus a wait. 150ms measured sufficient, 200 used.
- **Neither order gives one seamless transition.** `SETLB` and `LBLIG` are separate commands
  applied asynchronously, so the colour and the brightness visibly change a tick apart, whichever
  goes first. There is no command that sets both. A caller that needs a single clean transition
  must leave brightness fixed and scale the colours itself -- at the cost of 8-bit quantisation
  and its own gamma, since the firmware's PWM is finer than what an RGB triple can express.
- **Re-assert colours only.** `startKeepalive()` re-sends the last `SETLB` frame and no `LBLIG`.
  Pairing them made every tick destroy its own frame. Re-sending a frame the strip already shows
  is not visible: verified 2026-09-09 with a static frame re-sent every 2s, no flicker.
- A strip that has not changed is still worth a second look before suspecting the index map, but
  the first thing to suspect now is a brightness write next to the frame.

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

`APPNEW` is not in that string table. It came from the vendor's firmware updater
(`UpDateToolV3.exe`, shipped with VSD Craft): disassembling the code around its "send UpdateMode"
log line showed it building `CRT\0\0APPNEW` for `hid_write`. It was then verified on hardware.

The key scan description in §7 comes from disassembling the RISC-V code in the vendor's
publicly downloadable `V3.VSDM18.02.015` firmware image. It describes behaviour only; no vendor
code is reproduced here.

No opcode guessing against firmware was involved.
