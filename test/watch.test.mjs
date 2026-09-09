//
// Tests for StreamDock.watch(): the reconnect loop.
//
// This path had NO coverage until the device lookup became injectable, which
// is why its double-disconnect crash had to be found by pressing a button on
// real hardware and watching the process die. open() now takes { list,
// openPath }, so the whole loop runs against a fake device here.
//
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { StreamDock } from '../src/device/streamdock.js';
import { MODELS } from '../src/device/models.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakeHid extends EventEmitter {
  closed = 0;
  write() { return 1; }
  close() { this.closed += 1; }
}

// A fake hidapi presenting one m18, or nothing at all.
const fakeHid = () => {
  const state = { handles: [], present: true, opens: 0 };
  return {
    state,
    list: () => (state.present
      ? [{ usagePage: 0xffa0, vendorId: MODELS.m18.vendorId, productId: MODELS.m18.productId, path: 'fake:1' }]
      : []),
    openPath: () => {
      state.opens += 1;
      const handle = new FakeHid();
      state.handles.push(handle);
      return handle;
    },
  };
};

// --- the crash that 43544cc fixed ----------------------------------------

{
  // node-hid emits 'error' once per queued read on a dead handle, so
  // 'disconnect' can fire more than once for the same device. The second pass
  // used to read a null `current` and throw a TypeError out of lost.close(),
  // killing the process instead of waiting for the replug. On hardware this
  // took exactly one key press to trigger.
  const hid = fakeHid();
  const lost = [];
  const stop = StreamDock.watch(() => {}, { hid, pollMs: 10, onLost: e => lost.push(e) });
  await sleep(30);

  assert.equal(hid.state.opens, 1, 'the fake device should have been opened once');
  const handle = hid.state.handles[0];

  hid.state.present = false;   // unplugged; stop the loop reopening it
  handle.emit('error', new Error('read failed'));
  handle.emit('error', new Error('read failed again'));
  handle.emit('error', new Error('and again'));

  assert.equal(lost.length, 1, 'repeated read errors are ONE disconnect, not three');
  stop();
}

// --- it recovers, rather than merely surviving ---------------------------

{
  // Surviving the crash is not enough: onConnect must run again on replug, or
  // the daemon sits there with a live socket and a dead panel.
  const hid = fakeHid();
  const connects = [];
  const stop = StreamDock.watch(d => connects.push(d), { hid, pollMs: 10 });
  await sleep(30);
  assert.equal(connects.length, 1);

  hid.state.present = false;
  hid.state.handles[0].emit('error', new Error('unplugged'));
  await sleep(30);
  assert.equal(connects.length, 1, 'nothing to connect to while it is away');

  hid.state.present = true;    // plugged back in
  await sleep(40);
  assert.equal(connects.length, 2, 'onConnect must re-run so setup is re-applied');
  assert.notEqual(connects[0], connects[1], 'a replug is a NEW device object');
  stop();
}

// --- an absent dock is polled, not thrown -------------------------------

{
  // The daemon binds its port before touching the device, so it must be able
  // to start with nothing plugged in and wait.
  const hid = fakeHid();
  hid.state.present = false;
  const errors = [];
  const stop = StreamDock.watch(() => assert.fail('must not connect'),
    { hid, pollMs: 10, onError: e => errors.push(e) });
  await sleep(40);

  assert.ok(errors.length >= 1, 'the reason must be reported');
  assert.equal(errors[0].code, 'ENODOCK');
  assert.equal(errors.length, 1, 'the same reason must be reported ONCE, not every tick');
  stop();
}

// --- stop() closes the handle and halts the loop ------------------------

{
  const hid = fakeHid();
  const stop = StreamDock.watch(() => {}, { hid, pollMs: 10 });
  await sleep(30);
  const handle = hid.state.handles[0];
  stop();
  assert.equal(handle.closed, 1, 'stop() must close the device');
  const opensAtStop = hid.state.opens;
  await sleep(40);
  assert.equal(hid.state.opens, opensAtStop, 'stop() must halt the poll');
}

console.log('watch/reconnect tests passed');
