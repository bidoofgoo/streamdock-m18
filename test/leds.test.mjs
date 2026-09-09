//
// LED zone tests. No hardware needed: the driver takes its HID handle by
// injection, so a fake one records the reports and we assert on the bytes
// that would have gone out.
//
// These exist because the strip has NO feedback channel (see PROTOCOL.md):
// the device acknowledges nothing, so the only thing we can check
// automatically is that we build the frame we meant to. Whether the hardware
// then applies it needs a human looking at the ring.
//
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { StreamDock } from '../src/device/streamdock.js';
import { MODELS } from '../src/device/models.js';

class FakeHid extends EventEmitter {
  writes = 0;
  sent = [];
  write(bytes) {
    this.writes += 1;
    this.last = Buffer.from(bytes);
    this.sent.push(this.last);
    return bytes.length;
  }
  close() {}
}

// Reports are [report id][CRT\0\0][command tag]..., so the tag starts at 6.
// Counting commands by tag beats counting writes: one call can send several
// reports (setBrightness sends LIG then STP), which makes raw write counts
// meaningless as an assertion.
const tagsSent = hid => hid.sent.map(b => b.subarray(6, 11).toString('latin1'));
const countTag = (hid, tag) => tagsSent(hid).filter(t => t.startsWith(tag)).length;

// SETLB payload starts after the report ID byte, the 5 byte CRT prefix and
// the 5 byte command, so the first LED's red byte is at offset 11.
const RGB_OFFSET = 11;
const frameOf = hid => Array.from({ length: 24 },
  (_, i) => [...hid.last.subarray(RGB_OFFSET + i * 3, RGB_OFFSET + i * 3 + 3)]);

const newDock = (model = MODELS.m18) => {
  const hid = new FakeHid();
  return { hid, dock: new StreamDock(hid, model) };
};

// --- zone lookup ---------------------------------------------------------

{
  const { dock } = newDock();
  assert.equal(dock.ledIndices('all').length, 24);
  assert.deepEqual(dock.ledIndices('front'), [22, 23]);
  assert.equal(dock.ledIndices('ring').length, 22);
  assert.deepEqual(dock.ledIndices('top'), [14, 15, 16, 17, 18, 19]);
  // the left edge wraps past index 0, because the strip starts mid-edge
  assert.deepEqual(dock.ledIndices('left'), [20, 21, 0, 1, 2]);
  assert.throws(() => dock.ledIndices('diagonal'), /unknown LED zone/);
}

// --- the model's own consistency -----------------------------------------

{
  const { dock } = newDock();
  const zones = Object.values(MODELS.m18.ledZones).flat().sort((a, b) => a - b);
  assert.deepEqual(zones, dock.ledIndices('all'),
    'ledZones must partition the strip: every index exactly once');
  const edges = Object.values(MODELS.m18.ledEdges).flat().sort((a, b) => a - b);
  assert.deepEqual(edges, dock.ledIndices('ring'),
    'ledEdges must cover the ring exactly once');
}

// --- a zone write must not disturb anything else -------------------------

{
  const { hid, dock } = newDock();
  dock.setLedZoneColors('front', [9, 9, 9]);
  for (let i = 0; i < 22; i++) {
    dock.setLedZoneColors('ring', Array.from({ length: 22 },
      (_, j) => (j === i ? [255, 255, 255] : [0, 0, 0])));
    const frame = frameOf(hid);
    assert.deepEqual(frame[i], [255, 255, 255], `ring position ${i} should be lit`);
    assert.deepEqual(frame[22], [9, 9, 9], `front LED 22 disturbed at ring step ${i}`);
    assert.deepEqual(frame[23], [9, 9, 9], `front LED 23 disturbed at ring step ${i}`);
  }
}

// --- colours are indexed by position WITHIN the zone ---------------------

{
  const { hid, dock } = newDock({ ...MODELS.m18, ledZones: { ring: [20, 21], front: [0], dark: [] } });
  dock.setLedZoneColors('ring', [[1, 2, 3], [4, 5, 6]]);
  const frame = frameOf(hid);
  assert.deepEqual(frame[20], [1, 2, 3]);
  assert.deepEqual(frame[21], [4, 5, 6]);
  assert.deepEqual(frame[0], [0, 0, 0], 'zone position 0 is not device index 0');
}

// --- a multi-zone paint is a single write --------------------------------

{
  const { hid, dock } = newDock();
  hid.writes = 0;
  dock.setLedZones({ left: [1, 1, 1], bottom: [2, 2, 2], right: [3, 3, 3], top: [4, 4, 4] },
    { rest: [0, 0, 0] });
  assert.equal(hid.writes, 1, 'four edges must cost one SETLB, not four');
  const frame = frameOf(hid);
  assert.deepEqual(frame[0], [1, 1, 1]);   // left wraps past index 0
  assert.deepEqual(frame[3], [2, 2, 2]);
  assert.deepEqual(frame[13], [3, 3, 3]);
  assert.deepEqual(frame[14], [4, 4, 4]);
  assert.deepEqual(frame[22], [0, 0, 0], 'rest must black out the front LEDs');
}

// --- without rest, the retained frame survives ---------------------------

{
  const { hid, dock } = newDock();
  dock.setLedZones({ top: [7, 7, 7] }, { rest: [0, 0, 0] });
  dock.setLedZones({ front: [5, 5, 5] });
  const frame = frameOf(hid);
  assert.deepEqual(frame[22], [5, 5, 5]);
  assert.deepEqual(frame[14], [7, 7, 7], 'top edge survived a front-only write');
}

// --- resetLeds hands the strip back, so the retained frame is void -------

{
  const { dock } = newDock();
  dock.setLedColor(1, 2, 3);
  dock.resetLeds();
  assert.deepEqual(dock.ledFrame()[0], [0, 0, 0]);
}

// --- short and long colour arrays are clamped, never overrun -------------

{
  const { hid, dock } = newDock();
  dock.setLedColors([[1, 1, 1]]);
  assert.equal(hid.last.length, 1025, 'report size is fixed regardless of input length');
  assert.deepEqual(frameOf(hid)[23], [0, 0, 0], 'missing colours pad with black');
  dock.setLedColors(Array.from({ length: 99 }, () => [2, 2, 2]));
  assert.equal(hid.last.length, 1025);
  assert.deepEqual(frameOf(hid)[23], [2, 2, 2]);
}

// --- a model with no strip refuses, rather than writing nonsense ---------

{
  const { dock } = newDock({ ...MODELS.m18, hasRgbLed: false, name: 'no-strip' });
  assert.throws(() => dock.setLedColor(1, 2, 3), /no RGB light strip/);
  assert.throws(() => dock.ledIndices('ring'), /no RGB light strip/);
}

// --- the keepalive re-asserts the strip, but only when we own a frame -----

const sleep = ms => new Promise(r => setTimeout(r, ms));

{
  // nothing set yet: the strip must not be poked, or we would fight whatever
  // the firmware is currently showing
  const { hid, dock } = newDock();
  dock.startKeepalive('brightness', 25);
  await sleep(90);
  dock.stopKeepalive();
  assert.ok(countTag(hid, 'LIG') >= 2, 'the screen poke should have run at least twice');
  assert.equal(countTag(hid, 'SETLB'), 0, 'no frame is ours yet, so the strip must be left alone');
  assert.equal(countTag(hid, 'LBLIG'), 0);
}

{
  // Once a frame exists, every tick re-asserts THE FRAME AND NOTHING ELSE.
  //
  // This used to assert the opposite, that an LBLIG accompanied every re-sent
  // frame. That was wrong on hardware: a brightness write is applied
  // asynchronously and its render wipes any colour frame that arrived just
  // after it, so pairing the two made each keepalive tick destroy its own
  // colour. The strip only recovered on a tick where the timing happened to
  // work out, which is what made a status colour appear seconds late. See
  // setLedBrightness.
  const { hid, dock } = newDock();
  dock.setLedBrightness(60);
  dock.setLedColors(Array.from({ length: 24 }, () => [3, 2, 1]));
  hid.sent = [];
  dock.startKeepalive('brightness', 25);
  await sleep(90);
  dock.stopKeepalive();
  const frames = countTag(hid, 'SETLB');
  assert.ok(frames >= 2, `expected the frame re-sent each tick, saw ${frames}`);
  assert.equal(countTag(hid, 'LBLIG'), 0, 'a re-sent frame must NOT be preceded by a brightness write');
  assert.deepEqual(frameOf(hid)[0], [3, 2, 1], 'the re-sent frame must be the retained one');
}

{
  // A brightness write that changes nothing must not reach the device, since
  // it would wipe the next colour frame for no reason.
  const { hid, dock } = newDock();
  dock.setLedBrightness(40);
  assert.equal(countTag(hid, 'LBLIG'), 1, 'the first brightness write must go out');
  dock.setLedBrightness(40);
  assert.equal(countTag(hid, 'LBLIG'), 1, 'an unchanged brightness must be skipped');
  dock.setLedBrightness(41);
  assert.equal(countTag(hid, 'LBLIG'), 2, 'a real change must go out');
  dock.setLedBrightness(41, { force: true });
  assert.equal(countTag(hid, 'LBLIG'), 3, 'force must override the skip');
  dock.close();
}

{
  // after resetLeds the firmware owns the strip, so the poke must stay quiet
  const { hid, dock } = newDock();
  dock.setLedColors(Array.from({ length: 24 }, () => [3, 2, 1]));
  dock.resetLeds();
  hid.sent = [];
  dock.startKeepalive('brightness', 25);
  await sleep(90);
  dock.stopKeepalive();
  assert.equal(countTag(hid, 'SETLB'), 0, 'the strip must not be poked after resetLeds');
  assert.ok(countTag(hid, 'LIG') >= 2, 'the screen poke should still run');
}

{
  // opting out must be honoured
  const { hid, dock } = newDock();
  dock.setLedColors(Array.from({ length: 24 }, () => [3, 2, 1]));
  hid.sent = [];
  dock.startKeepalive('brightness', 25, { leds: false });
  await sleep(90);
  dock.stopKeepalive();
  assert.equal(countTag(hid, 'SETLB'), 0, 'leds:false must skip the strip');
  assert.ok(countTag(hid, 'LIG') >= 2, 'the screen poke should still run');
}

console.log('LED zone tests passed');
