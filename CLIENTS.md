# Writing a client for `dockd`

How an external program drives a Stream Dock M18 over the daemon's socket.

This is the reference for **application** authors. If you are writing a driver, or porting to
another Stream Dock model, you want [PROTOCOL.md](PROTOCOL.md) instead — that documents the USB
HID wire protocol, and nothing here requires knowing any of it.

## Why a daemon

`hidapi` grants **exclusive** access to the HID interface, so only one process can hold the dock.
A second program that opens it directly simply fails. So one process owns the device and everyone
else talks to it over TCP.

```bash
npm run dockd     # owns the dock, listens on 127.0.0.1:5548
```

The daemon also absorbs the two awkward parts of this hardware, so clients never see them: it
re-asserts brightness every 8s to stop the panel reverting to its stock screen when idle, and it
re-applies device setup after an unplug.

## Connecting

**TCP to `127.0.0.1:5548`**, newline-delimited JSON in both directions. One object per line, `\n`
terminated. That format was chosen because it needs no library in any language — `nc 127.0.0.1
5548` is a working client, and so is anything that can open a socket. Processing's built-in
`processing.net.Client` reads it with `readStringUntil('\n')`.

Port 5548 is the dock's USB vendor id. It doubles as the single-instance lock: a second daemon
fails to bind and exits rather than fighting over the device.

Localhost only by default, and deliberately — this is not an internet service. `--host` widens it
if you must, but there is no authentication of any kind.

On connect you immediately get a `hello`:

```json
{"type":"hello","protocol":1,"attached":true,"state":"online",
 "device":"VSDinside Stream Dock M18 (15 keys + 3)",
 "keys":15,"aux":3,"keyWidth":64,"keyHeight":64,"maxImageBytes":10240,
 "leds":24,"ledZones":["ring","front","dark"],
 "ledEdges":["left","bottom","right","top"]}
```

**Read the layout from `hello` rather than hardcoding it.** Key count, tile size, byte budget and
the LED zone names all come from the device profile, so a client that reads them works on a
related model without changes. `state` is `online` or `offline`; a client can connect before the
dock is plugged in.

## Coordinates

**Keys are addressed by grid index, 0-based, from the top-left, reading left to right.** Index 0
is top-left, 4 ends the top row, 14 is bottom-right.

Indices **15, 16, 17** are the three plain buttons with no screen — left, middle, right. They
report presses like any other key and take no images. They carry **no built-in meaning**: the
daemon does not claim them for paging or anything else, so they are yours.

Do not be tempted by the raw device ids if you see them in a trace. This hardware uses two
different numberings for the same physical key depending on direction, and the driver already
resolves both to one grid index. See PROTOCOL.md §7 if you are curious.

## Commands

Client to daemon. Add an optional `"id"` to any command and it comes back on the reply, so you can
match responses to requests.

| Command | Effect |
|---|---|
| `{"cmd":"key","index":0,"label":"Rain"}` | render a text label on a key. `color` and `textColor` are optional hex strings |
| `{"cmd":"keyImage","index":0,"jpeg":"<base64>"}` | your own artwork. **Read the warning below** |
| `{"cmd":"clear"}` | blank every key |
| `{"cmd":"clear","index":3}` | blank one key |
| `{"cmd":"brightness","value":80}` | screen brightness, 0-100 |
| `{"cmd":"led","zone":"ring","color":[0,80,255]}` | set one LED zone |
| `{"cmd":"led","zone":"top","color":[255,0,0],"rest":[0,0,0]}` | set a zone and blank everything else |
| `{"cmd":"ledFrame","colors":[[255,0,0], ...]}` | all 24 LEDs at once, by strip index |
| `{"cmd":"ledBrightness","value":60}` | strip brightness, 0-100 |
| `{"cmd":"ledOff"}` | hand the strip back to its built-in effect |
| `{"cmd":"attach"}` / `{"cmd":"detach"}` | resume / stop receiving events and writing |
| `{"cmd":"ping"}` | liveness check, replies `{"type":"ok","pong":true}` |

Colours in `led` commands are **`[r, g, b]` arrays, 0-255** — not hex strings. Hex is for the
`key` command's `color`/`textColor`. Getting that backwards is an easy slip and returns
`color must be [r, g, b], got "#ff00ff"`.

LED zone names come from `hello`: `ring` (indices 0-21), `front` (22-23), `all`, plus the ring's
four edges `left`, `bottom`, `right`, `top`. Index 0 is the middle of the left edge and the strip
runs counter-clockwise; **no LED sits on a corner.** PROTOCOL.md §8 has the geometry if you want
to build effects that respect it.

## Events

Daemon to client, one JSON object per line.

| Event | Meaning |
|---|---|
| `{"type":"hello",...}` | sent on connect, with the device description above |
| `{"type":"key","index":3,"state":1,"aux":false}` | key down (`state` 1) or up (`state` 0) |
| `{"type":"device","state":"online",...}` | the dock appeared, or came back after an unplug. **Repaint.** |
| `{"type":"device","state":"offline","reason":"..."}` | the dock went away |
| `{"type":"ok","id":7}` | the command with `id` 7 succeeded |
| `{"type":"error","id":7,"message":"..."}` | it did not, and why |

Every press produces a matching release. Verified on hardware across all 18 buttons: no dropped
edges, no phantom repeats, no stuck keys.

A `detach`ed client still receives `device` events, because a client that unhooked for focus
reasons must still learn that the panel went blank. It does not receive `key` events.

## Errors you will actually hit

Errors never drop the connection — an app under development sends nonsense constantly, and losing
the socket for it would be miserable to debug. You get a line and carry on.

| Message | Cause |
|---|---|
| `not valid JSON` | malformed line. No `id` on the reply, since none could be read |
| `no dock connected` | daemon is up, dock is not plugged in |
| `detached; send {"cmd":"attach"} first` | you sent a write while detached |
| `index must be 0..14, got 99` | out of range for this model's `keys` |
| `key needs a "label" field` | see the gotcha below |
| `unknown LED zone "x" (known: ...)` | the message lists the valid names |
| `color must be [r, g, b], got "#ff00ff"` | hex string where an array belongs |
| `unknown command "x"` | typo in `cmd` |

## Five things that will bite you

**1. `key` requires `label`, and used to not.** A missing `label` is now an error. It previously
defaulted to an empty string, so a client using `text` instead of `label` painted fifteen blank
keys and received fifteen `ok` replies. If you are reading an older copy of this repo, that is
why your keys are blank. An explicit `"label":""` is still accepted, though `clear` says it
better.

**2. `keyImage` dimensions are not checked, and getting them wrong corrupts OTHER keys.** The
daemon verifies the payload is a JPEG within `maxImageBytes`, because both are cheap. It does not
decode the image to measure it. The device blits into a fixed per-key framebuffer, so anything
larger than `keyWidth`×`keyHeight` overruns into the next key's memory — a 150×150 tile visibly
smears across the keys below. **Resize to exactly 64×64 before sending**, or use `key` and let the
daemon render.

**3. Send LED colour BEFORE LED brightness.** A brightness change is applied asynchronously and
its render reads the device's own frame buffer, so a colour arriving just *after* it is wiped —
your colour flashes and vanishes. A colour already in the buffer is picked up correctly. Send
`led` then `ledBrightness`, never the reverse. Neither order gives one seamless transition; the
two changes always land a tick apart. PROTOCOL.md §8 has the measurements.

**4. Last writer wins, and the daemon does not remember who wrote what.** Any attached client can
write any key. If several apps share the dock, have each one `detach` when it loses focus.

**5. The daemon never repaints for you.** After a `device`/`online` event the panel is blank, and
only your app knows what it wanted there. It deliberately does not remember and replay your keys:
it cannot know which app still wants which key, and guessing would fight the last-writer-wins
rule.

## The status screen

With no client connected the daemon paints its own screen, because a blank panel is ambiguous —
daemon not running, dock unplugged, app not connected, app connected but silent, and app crashed
mid-paint all look identical.

| State | Screen | Ring |
|---|---|---|
| no client | `waiting` `for` `a` `client` / `on` `port` `5548` | dim amber |
| client connected, nothing painted | `waiting` `for` `input` / `app` `connected` | dim blue |
| client has painted | yours; the daemon stops touching it | yours |

**Ownership is tracked separately for screen and strip.** An app that only drives the LEDs keeps
the helpful status screen, and vice versa. Ownership resets when the last client disconnects, and
after an unplug. `--no-status` turns it off entirely.

## A complete client

Node, no dependencies. Paints the grid, drives the ring, reacts to presses, survives a replug.

```js
import net from 'node:net';

const sock = net.connect(5548, '127.0.0.1');
sock.setEncoding('utf8');

const send = o => sock.write(JSON.stringify(o) + '\n');
let device = null;

const paint = () => {
  for (let i = 0; i < device.keys; i++) send({ cmd: 'key', index: i, label: `${i}` });
  send({ cmd: 'led', zone: 'ring', color: [0, 80, 255] });   // colour first,
  send({ cmd: 'ledBrightness', value: 40 });                 // then brightness
};

let buffer = '';
sock.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;

    const msg = JSON.parse(line);
    switch (msg.type) {
      case 'hello':
        device = msg;                          // read the layout, do not hardcode it
        if (msg.state === 'online') paint();
        break;
      case 'device':
        if (msg.state === 'online') { device = msg; paint(); }   // panel came back blank
        break;
      case 'key':
        if (msg.state === 1) console.log(`pressed ${msg.index}${msg.aux ? ' (aux)' : ''}`);
        break;
      case 'error':
        console.error('daemon said: ' + msg.message);
        break;
    }
  }
});

sock.on('error', err => console.error('socket: ' + err.message));
```

Note the buffering. **TCP does not preserve message boundaries**, so a large `keyImage` arrives in
several chunks and two small commands can arrive in one. Split on `\n`; never assume one `data`
event is one message.

## Without the daemon

If your app is the only thing that will ever touch the dock, you can skip the socket and use the
driver directly:

```js
import { StreamDock } from 'streamdock-m18';

const dock = StreamDock.open();
dock.connect();
dock.setBrightness(80);
dock.on('key', ev => console.log(ev.index, ev.state));
```

`StreamDock.watch()` is the better entry point for anything long-lived — it survives unplugs and
re-runs your setup on every reconnect. You then own the keepalive (`startKeepalive()`) and the
reconnect repaint yourself, which is precisely what the daemon exists to do for you. README.md
has the trade-off in full.
