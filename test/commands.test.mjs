//
// Tests for the daemon's command vocabulary. No hardware, no sockets: the
// driver takes its HID handle by injection, so a fake one records the reports
// and we assert on what would have gone out.
//
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { StreamDock } from '../src/device/streamdock.js';
import { MODELS } from '../src/device/models.js';
import { applyCommand, describe } from '../src/service/commands.js';

class FakeHid extends EventEmitter {
  sent = [];
  write(bytes) { this.sent.push(Buffer.from(bytes)); return bytes.length; }
  close() {}
}

const newDock = () => {
  const hid = new FakeHid();
  return { hid, dock: new StreamDock(hid, MODELS.m18) };
};
const tags = hid => hid.sent.map(b => b.subarray(6, 11).toString('latin1'));
// Report layout: [report id][CRT\0\0 = 5][command = 5][args...]. For BAT the
// args are u16be size then the raw key id, so the key id lands at offset 13.
const BAT_KEY_ID = 13;
const CLE_KEY_ID = 12;
const withTag = (hid, tag) => hid.sent.filter(b => b.subarray(6, 11).toString('latin1').startsWith(tag));

// --- what a client is told on connect ------------------------------------

{
  const { dock } = newDock();
  const info = describe(dock);
  assert.equal(info.keys, 15);
  assert.equal(info.aux, 3);
  assert.equal(info.leds, 24);
  assert.deepEqual(info.ledZones, ['ring', 'front', 'dark']);
  assert.deepEqual(info.ledEdges, ['left', 'bottom', 'right', 'top']);
  assert.equal(info.keyWidth, 64);
}

// --- a label goes to the right RAW key id --------------------------------

{
  // The single most dangerous thing in this codebase is that images and key
  // events use different numbering. Grid index 0 is the top-left key, which is
  // raw id 0x0b for an image. If this assertion ever fails, every icon on the
  // panel is two rows out.
  const { hid, dock } = newDock();
  applyCommand(dock, { cmd: 'key', index: 0, label: 'Rain' });
  const begin = withTag(hid, 'BAT');
  assert.equal(begin.length, 1, 'one BAT header per key image');
  assert.equal(begin[0][BAT_KEY_ID], 0x0b, 'grid index 0 must address raw image id 0x0b');

  hid.sent = [];
  applyCommand(dock, { cmd: 'key', index: 14, label: 'last' });
  assert.equal(withTag(hid, 'BAT')[0][BAT_KEY_ID], 0x05, 'grid index 14 must address raw image id 0x05');
}

// --- key events resolve to grid indices, flipped the other way -----------

{
  const { hid, dock } = newDock();
  const seen = [];
  dock.on('key', ev => seen.push(ev));
  const report = keyId => {
    const buf = Buffer.alloc(512);
    Buffer.from([0x41, 0x43, 0x4b, 0x00, 0x00, 0x4f, 0x4b, 0x00]).copy(buf, 0);
    buf[9] = keyId;
    buf[10] = 1;
    return buf;
  };
  hid.emit('data', report(0x01));   // top-left key PRESSED reports 0x01, not 0x0b
  hid.emit('data', report(0x25));   // first aux button
  assert.deepEqual(seen.map(e => e.index), [0, 15]);
  assert.equal(seen[1].aux, true);
}

// --- a raw image is validated, because a bad one corrupts other keys -----

{
  const { dock } = newDock();
  const jpeg = b64 => ({ cmd: 'keyImage', index: 0, jpeg: b64 });
  assert.throws(() => applyCommand(dock, jpeg('')), /needs a base64/);
  assert.throws(() => applyCommand(dock, jpeg(Buffer.from([1, 2, 3, 4]).toString('base64'))),
    /not a JPEG/, 'a non-JPEG payload must be refused, not blitted');
  const huge = Buffer.alloc(20000);
  Buffer.from([0xff, 0xd8, 0xff]).copy(huge, 0);
  assert.throws(() => applyCommand(dock, jpeg(huge.toString('base64'))),
    /device limit is 10240/, 'oversized images corrupt neighbouring keys, so refuse them');

  const ok = Buffer.alloc(64);
  Buffer.from([0xff, 0xd8, 0xff]).copy(ok, 0);
  const result = applyCommand(dock, jpeg(ok.toString('base64')));
  assert.deepEqual(result, { ok: true, bytes: 64 });
}

// --- bad arguments are refused with a message a human can act on ---------

{
  const { dock } = newDock();
  assert.throws(() => applyCommand(dock, { cmd: 'key', index: 15, label: 'x' }), /index must be 0..14/);
  assert.throws(() => applyCommand(dock, { cmd: 'key', index: -1, label: 'x' }), /index must be 0..14/);
  assert.throws(() => applyCommand(dock, { cmd: 'brightness', value: 900 }), /value must be 0..100/);
  assert.throws(() => applyCommand(dock, { cmd: 'led', zone: 'nope', color: [1, 2, 3] }), /unknown LED zone/);
  assert.throws(() => applyCommand(dock, { cmd: 'led', zone: 'ring', color: [1, 2] }), /must be \[r, g, b\]/);
  assert.throws(() => applyCommand(dock, { cmd: 'led', zone: 'ring', color: [0, 0, 300] }), /must be 0..255/);
  assert.throws(() => applyCommand(dock, { cmd: 'ledFrame', colors: 'red' }), /needs a "colors" array/);
  assert.throws(() => applyCommand(dock, { cmd: 'nonsense' }), /unknown command "nonsense"/);
}

// --- LED commands reach the strip ----------------------------------------

{
  const { hid, dock } = newDock();
  applyCommand(dock, { cmd: 'led', zone: 'top', color: [10, 20, 30], rest: [0, 0, 0] });
  const frame = withTag(hid, 'SETLB').at(-1);
  const at = i => [...frame.subarray(11 + i * 3, 14 + i * 3)];
  assert.deepEqual(at(14), [10, 20, 30]);
  assert.deepEqual(at(0), [0, 0, 0], 'rest cleared the rest of the strip');

  applyCommand(dock, { cmd: 'ledBrightness', value: 55 });
  assert.equal(withTag(hid, 'LBLIG').at(-1)[11], 55);

  applyCommand(dock, { cmd: 'ledOff' });
  assert.ok(tags(hid).some(t => t.startsWith('DELED')));
}

// --- clear with and without an index -------------------------------------

{
  const { hid, dock } = newDock();
  applyCommand(dock, { cmd: 'clear' });
  assert.equal(withTag(hid, 'CLE').at(-1)[CLE_KEY_ID], 0xff, 'no index clears every key');
  hid.sent = [];
  applyCommand(dock, { cmd: 'clear', index: 0 });
  assert.equal(withTag(hid, 'CLE').at(-1)[CLE_KEY_ID], 0x0b, 'index 0 clears raw image id 0x0b');
}

console.log('daemon command tests passed');
