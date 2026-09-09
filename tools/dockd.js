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

const log = (...args) => { if (!QUIET) console.log(...args); };

let dock = null;              // the live device, or null while it is away

// All client bookkeeping lives in the hub, which knows nothing about sockets
// and is therefore testable. This file is left with just the wiring.
const hub = createHub({ getDock: () => dock, log });
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
