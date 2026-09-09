#!/usr/bin/env node
//
// The dock daemon: one process owns the device, any number of sketches talk to
// it over a local TCP socket.
//
// Why a daemon at all: hidapi grants EXCLUSIVE access to the HID interface, so
// only one process can ever hold the dock. Two Processing sketches opening it
// directly means the second one simply fails. Putting the device behind a
// socket is the only shape that lets several sketches share it, and it also
// keeps the two sharp edges (the idle-revert keepalive, and re-applying state
// after an unplug) in one place instead of in every sketch.
//
// Wire format is newline-delimited JSON in both directions, because
// Processing's built-in processing.net.Client reads exactly that with
// readStringUntil('\n') and needs no library.
//
import net from 'node:net';
import { StreamDock } from '../src/device/streamdock.js';
import { describe } from '../src/service/commands.js';
import { createHub } from '../src/service/hub.js';
import { paintStatus } from '../src/service/status.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(flag('port', 5548));      // 0x5548 is the dock's USB vendor id
const HOST = flag('host', '127.0.0.1');       // localhost only; this is not an internet service
const BRIGHTNESS = Number(flag('brightness', 80));
const KEEPALIVE_MS = Number(flag('keepalive-ms', 8000));
const QUIET = argv.includes('--quiet');
const STATUS = !argv.includes('--no-status');

const log = (...args) => { if (!QUIET) console.log(...args); };

let dock = null;              // the live device, or null while it is away

// Who owns what. The daemon shows a status screen while nothing else is using
// the panel, and gets out of the way the moment a client paints. Screen and
// strip are tracked separately so an app that only drives the LEDs keeps the
// helpful screen, and vice versa.
const owned = { screen: false, strip: false };

const SCREEN_COMMANDS = new Set(['key', 'keyImage', 'clear', 'brightness']);
const STRIP_COMMANDS = new Set(['led', 'ledFrame', 'ledBrightness', 'ledOff']);

/** Repaints the status screen, if the daemon still owns anything to paint on. */
function showStatus(state) {
  if (!STATUS || !dock || owned.screen) return;
  try {
    paintStatus(dock, state, { port: PORT, leds: !owned.strip });
  } catch (err) {
    // Never let a status screen take the daemon down: it is a convenience, and
    // rendering needs the optional canvas dependency.
    log(`could not paint status screen: ${err.message}`);
  }
}

// All client bookkeeping lives in the hub, which knows nothing about sockets
// and is therefore testable. This file is left with just the wiring.
const hub = createHub({
  getDock: () => dock,
  log,
  onApplied: message => {
    if (SCREEN_COMMANDS.has(message.cmd)) owned.screen = true;
    if (STRIP_COMMANDS.has(message.cmd)) owned.strip = true;
  },
  onClients: count => {
    if (count > 0) { showStatus('ready'); return; }
    // The last client left, so nothing is driving the panel any more and the
    // daemon takes it back. Their artwork is still on the keys otherwise, which
    // would look like a working app that has silently died.
    owned.screen = false;
    owned.strip = false;
    showStatus('waiting');
  },
});
const broadcast = hub.broadcast;

// --- the device ----------------------------------------------------------

// Called only once the port is bound, so a second instance never touches the
// device. Otherwise it opens the HID interface first, fails with hidapi's
// exclusive-access error, and reports that instead of the real problem: that
// a daemon is already running and this one is redundant.
const watchForDock = () => StreamDock.watch(connected => {
  dock = connected;
  log(`dock connected: ${connected.model.name}`);

  // Everything the device needs goes in here, because watch() re-runs this on
  // every reconnect and the panel comes back blank.
  connected.connect();
  connected.setBrightness(BRIGHTNESS);
  connected.startKeepalive('brightness', KEEPALIVE_MS);

  // A reconnect blanks the panel, so whatever a client had painted is gone;
  // ownership resets and the daemon says what is going on until they repaint.
  owned.screen = false;
  owned.strip = false;
  showStatus(hub.size > 0 ? 'ready' : 'waiting');

  connected.on('key', ev => broadcast({ type: 'key', index: ev.index, state: ev.state, aux: !!ev.aux }));

  // Sketches need to know the panel went blank, so they can repaint. The
  // daemon deliberately does NOT remember and replay their keys: it has no way
  // to know which sketch still wants which key, and guessing would fight the
  // last-writer-wins rule.
  broadcast({ type: 'device', state: 'online', ...describe(connected) }, { attachedOnly: false });
}, {
  onError: err => log(`waiting for dock: ${err.message}`),
  onLost: err => {
    dock = null;
    log(`dock lost: ${err?.message ?? 'unknown'}`);
    broadcast({ type: 'device', state: 'offline', reason: err?.message ?? 'unknown' }, { attachedOnly: false });
  },
});

// --- the socket ----------------------------------------------------------

const server = net.createServer(socket => {
  socket.setNoDelay(true);
  const connection = hub.addClient({ write: line => socket.write(line) });

  socket.on('data', chunk => connection.feed(chunk));
  socket.on('error', () => {});   // an app closing its window is not an error worth logging
  socket.on('close', () => connection.remove());
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    // The port IS the single-instance lock: no lockfile to go stale, and the
    // check is atomic because the OS does it.
    console.error(`port ${PORT} is already in use, so the daemon is probably already running.`);
    console.error('Only one process can hold the dock, so this one is exiting.');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  log(`dockd listening on ${HOST}:${PORT}`);
  log('newline-delimited JSON. try: nc 127.0.0.1 ' + PORT);
  watchForDock();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('\nclosing');
    server.close();
    dock?.close();
    process.exit(0);
  });
}
