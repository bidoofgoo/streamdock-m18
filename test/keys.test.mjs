//
// Tests for key event bookkeeping: which keys are held, rollover detection,
// and releasing everything on disconnect. No hardware: input reports are fed
// to a fake HID handle exactly as the device would send them.
//
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { StreamDock } from '../src/device/streamdock.js';
import { MODELS } from '../src/device/models.js';

class FakeHid extends EventEmitter {
  write(bytes) { return bytes.length; }
  close() {}
}

const ACK_OK = [0x41, 0x43, 0x4b, 0x00, 0x00, 0x4f, 0x4b, 0x00];
const report = (keyId, state) => {
  const buf = Buffer.alloc(512);
  Buffer.from(ACK_OK).copy(buf);
  buf[9] = keyId;
  buf[10] = state;
  return buf;
};

const newDock = () => {
  const hid = new FakeHid();
  const dock = new StreamDock(hid, MODELS.m18);
  const events = [];
  dock.on('key', ev => events.push(ev));
  dock.on('disconnect', () => {});
  return { hid, dock, events, press: (id, s) => hid.emit('data', report(id, s)) };
};

// --- stock firmware: strictly one key at a time --------------------------

{
  const { dock, press } = newDock();
  press(0x01, 1); press(0x01, 0); press(0x0f, 1); press(0x0f, 0);
  assert.deepEqual(dock.held, []);
  assert.equal(dock.rolloverSeen, false, 'one key at a time is not rollover');
}

// --- rollover firmware: chords are tracked -------------------------------

{
  const { dock, press } = newDock();
  press(0x01, 1); press(0x03, 1); press(0x05, 1);
  assert.deepEqual(dock.held, [0, 2, 4]);
  assert.equal(dock.rolloverSeen, true);
  press(0x03, 0);
  assert.deepEqual(dock.held, [0, 4]);
  press(0x01, 0); press(0x05, 0);
  assert.deepEqual(dock.held, []);
}

// --- aux buttons take part like any other key ----------------------------

{
  const { dock, events, press } = newDock();
  press(0x08, 1); press(0x30, 1);
  assert.deepEqual(dock.held, [7, 16]);
  assert.equal(events.at(-1).aux, true);
}

// --- a repeated down is not rollover -------------------------------------

{
  const { dock, press } = newDock();
  press(0x02, 1); press(0x02, 1);
  assert.equal(dock.rolloverSeen, false);
  assert.deepEqual(dock.held, [1]);
}

// --- unknown ids are passed on but not tracked ---------------------------

{
  const { dock, events, press } = newDock();
  press(0x40, 1);
  assert.equal(events[0].index, -1);
  assert.deepEqual(dock.held, []);
}

// --- disconnect releases everything that was held ------------------------

{
  // A MIDI client would otherwise keep a note sounding forever.
  const { hid, dock, events, press } = newDock();
  press(0x06, 1); press(0x31, 1);
  events.length = 0;
  hid.emit('error', new Error('unplugged'));
  assert.deepEqual(events.map(e => [e.index, e.keyId, e.state, e.synthetic]), [
    [5, 0x06, 0, true],
    [17, 0x31, 0, true],
  ]);
  assert.deepEqual(dock.held, []);
}

console.log('keys: ok');
