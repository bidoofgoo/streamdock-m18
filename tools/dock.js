#!/usr/bin/env node
//
// Exploratory CLI for the Stream Dock. Everything here exists to answer a
// question about the hardware; once a question is answered the finding moves
// into src/device/models.js and PLAN.md.
//
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { StreamDock } from '../src/device/streamdock.js';
import { calibrationTile, textTile, rotateCanvas, encodeJpeg } from '../src/device/icons.js';

const argv = process.argv.slice(2);
const command = argv[0];
const positional = argv.slice(1).filter(a => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => argv.includes(`--${name}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => '0x' + n.toString(16).padStart(2, '0');

// fileURLToPath, not .pathname: on Windows a file: URL's pathname keeps a
// leading slash ("/e:/Apps/..."), which fs then resolves against the current
// drive and turns into "e:\e:\Apps\...". Only bites off-POSIX.
const KEY_LOG = fileURLToPath(new URL('../key-events.log', import.meta.url));

let loggedKeyLogFailure = false;

function logKeys(dock) {
  dock.on('key', ev => {
    const line = `${new Date().toISOString()} rawKey=${hex(ev.keyId)} state=${ev.state} index=${ev.index}${ev.aux ? ' aux' : ''}`;
    console.log('  KEY  ' + line);
    // Best effort. node-hid re-emits a throw from this handler as a read
    // error, which the driver then treats as an unplug, so an unwritable log
    // used to masquerade as the dock vanishing. The console line above is the
    // record that matters; the file is a convenience.
    try {
      appendFileSync(KEY_LOG, line + '\n');
    } catch (err) {
      if (!loggedKeyLogFailure) {
        loggedKeyLogFailure = true;
        console.error(`  (key log unavailable: ${err.message})`);
      }
    }
  });
  dock.on('input', buf => {
    if (has('raw')) console.log('  IN   ' + [...buf.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join(' '));
  });
  dock.on('error', err => console.error('  ERR  ' + err.message));
}

/**
 * Opens the dock, runs setup on it, and holds the process open until Ctrl-C,
 * re-running setup if the dock is unplugged and plugged back in.
 *
 * The heartbeat is opt-in via --heartbeat=<ms>. It is speculative and one
 * device dropped off the bus while it was running, so it stays off unless
 * asked for. See the note on startHeartbeat().
 */
async function withDock(setup, message) {
  const keepalive = flag('keepalive', 'brightness');
  const keepaliveMs = Number(flag('keepalive-ms', 8000));
  let waiting = true;

  const stop = StreamDock.watch(async dock => {
    waiting = false;
    console.log(`connected: ${dock.model.name}`);
    logKeys(dock);
    if (keepalive !== 'none') {
      const leds = flag('keepalive-leds', 'on') !== 'off';
      dock.startKeepalive(keepalive, keepaliveMs, { leds });
      console.log(`keepalive: ${keepalive} every ${keepaliveMs}ms${leds ? ' (screen + strip)' : ' (screen only)'}`);
    }
    try {
      await setup(dock);
    } catch (err) {
      console.error('  setup failed: ' + err.message);
    }
    console.log(`\n${message}\nHolding open. Ctrl-C to stop.`);
  }, {
    onError: err => console.log(`waiting for dock: ${err.message}`),
    onLost: err => {
      console.log(`\ndock disconnected (${err?.message ?? 'unknown'}). Waiting for it to come back...`);
    },
  });

  if (waiting) console.log('waiting for the dock to be plugged in...');
  process.on('SIGINT', () => { console.log('\nclosing'); stop(); process.exit(0); });
  await new Promise(() => {});
}

const commands = {
  info() {
    const found = StreamDock.list();
    if (!found.length) return console.log('No 0x5548 device found.');
    const d = found[0];
    console.log(`${d.product}  serial ${d.serialNumber}  ${hex(d.vendorId)}:${hex(d.productId)}\n`);
    for (const i of found) {
      const kind = i.usagePage === 0xffa0 ? 'VENDOR (control channel)'
                 : i.usagePage === 0x01 && i.usage === 0x06 ? 'keyboard (ignored)' : 'other';
      console.log(`  interface ${i.interface}  usagePage 0x${i.usagePage.toString(16)}  usage ${i.usage}  ${kind}`);
    }
  },

  blink: () => withDock(async dock => {
    dock.connect({ clear: false });
    console.log('Watch the panel.\n');
    for (const [label, v] of [['OFF', 0], ['DIM', 15], ['FULL', 100], ['OFF', 0], ['FULL', 100]]) {
      dock.setBrightness(v);
      console.log(`  ${label.padEnd(6)} ${String(v).padStart(3)}`);
      await sleep(1400);
    }
    dock.setBrightness(70);
  }, 'Left at brightness 70.'),

  bright: () => withDock(dock => {
    dock.connect({ clear: false });
    dock.setBrightness(Number(positional[0]));
  }, `Brightness set to ${positional[0]}.`),

  clear: () => withDock(dock => {
    dock.connect({ clear: false });
    if (positional[0]) dock.clearKey(Number(positional[0])); else dock.clearAll();
  }, 'Cleared.'),

  /**
   * Pushes a numbered calibration tile to every candidate raw key id.
   * Answers three questions at once, just by looking at the panel:
   *   - which physical key each raw id drives  (read the numbers)
   *   - the panel rotation                     (where is the red square?)
   *   - the correct image size                 (does the tile fill the key?)
   */
  calibrate: () => withDock(async dock => {
    const size = Number(flag('size', dock.model.keyWidth));
    const rot = Number(flag('rot', dock.model.keyRotation));
    const last = Number(flag('to', 18));

    console.log(`Calibrating: ${size}x${size} JPEG, rotated ${rot} degrees, raw ids 1..${last}\n`);
    dock.connect();
    dock.setBrightness(Number(flag('brightness', 80)));

    for (let id = 1; id <= last; id++) {
      const tile = rotateCanvas(calibrationTile(id, { width: size, height: size }), rot);
      const { buf } = encodeJpeg(tile, dock.model.maxImageBytes);
      try {
        dock.setKeyImageRaw(id, buf);
        process.stdout.write(`${id} `);
      } catch {
        process.stdout.write(`${id}:FAIL `);
      }
      await sleep(60);
    }
  },
      `\nDone. Now read the panel:\n` +
      `  1. What numbers do you see, and in what physical arrangement?\n` +
      `  2. Where is the red square on each tile? (top-left means rotation ${flag('rot', 180)} is correct)\n` +
      `  3. Does each tile fill its key, or is it cropped / too small / repeated?\n` +
      `  4. Press each button; presses are logged to key-events.log`),

  /**
   * Pushes the SAME tile at a different size to each key, labelled with the
   * size that produced it. Whichever key looks clean tells us the real key
   * resolution in one pass, with no guessing between runs.
   */
  sizes: () => withDock(async dock => {
    const rot = Number(flag('rot', dock.model.keyRotation));
    const candidates = (flag('list', '64,72,80,85,88,96,100,104,112,120,126,128,132,144,150,160,176,200'))
      .split(',').map(Number);

    dock.connect();
    dock.setBrightness(Number(flag('brightness', 80)));
    console.log(`Sweeping ${candidates.length} sizes at rotation ${rot}.\n`);

    for (let i = 0; i < candidates.length && i < 18; i++) {
      const size = candidates[i];
      // the label IS the size, so the panel is self-describing
      const tile = rotateCanvas(calibrationTile(size, { width: size, height: size }), rot);
      const { buf } = encodeJpeg(tile, dock.model.maxImageBytes);
      try {
        dock.setKeyImageRaw(i + 1, buf);
        console.log(`  raw key ${String(i + 1).padStart(2)}  ->  ${size}x${size}  (${buf.length} bytes)`);
      } catch (err) {
        console.log(`  raw key ${String(i + 1).padStart(2)}  ->  ${size}x${size}  FAILED: ${err.message}`);
      }
      await sleep(80);
    }
  }, 'Which key looks CORRECT? Each tile is labelled with the size that made it.\n' +
     'Look for: a clean square, one red corner, one green border, no repeats or diagonal shear.'),

  /**
   * Same tile and size on every key, but a different rotation per key.
   * Run this once the size is known.
   */
  rotations: () => withDock(async dock => {
    const size = Number(flag('size', dock.model.keyWidth));
    const candidates = [0, 90, 180, 270];
    dock.connect();
    dock.setBrightness(Number(flag('brightness', 80)));
    for (let i = 0; i < candidates.length; i++) {
      const rot = candidates[i];
      const tile = rotateCanvas(calibrationTile(rot, { width: size, height: size }), rot);
      dock.setKeyImageRaw(i + 1, encodeJpeg(tile, dock.model.maxImageBytes).buf);
      console.log(`  raw key ${i + 1}  ->  rotation ${rot}`);
      await sleep(80);
    }
  }, 'On which key is the RED SQUARE in the top-left? Its label is the correct rotation.'),

  /**
   * Decisive single round. Puts three candidate sizes on well-separated keys
   * so any overspill has room to show itself, and four rotations on the last
   * four keys. Then holds the panel with a gentle refresh keepalive so we can
   * also find out whether that stops the dock reverting to its stock screen.
   */
  fit: () => withDock(async dock => {
    const push = (rawKey, label, size, rot) => {
      const tile = rotateCanvas(calibrationTile(label, { width: size, height: size }), rot);
      dock.setKeyImageRaw(rawKey, encodeJpeg(tile, dock.model.maxImageBytes).buf);
    };

    dock.connect();
    dock.setBrightness(Number(flag('brightness', 80)));

    // sizes, spaced 4 keys apart so overspill is unambiguous
    console.log('sizes:');
    for (const [rawKey, size] of [[1, 64], [5, 72], [9, 80]]) {
      push(rawKey, String(size), size, 180);
      console.log(`  raw key ${rawKey} -> ${size}x${size}`);
      await sleep(80);
    }

    // rotations, all at 64 so they cannot spill
    console.log('rotations (all 64x64):');
    for (const [rawKey, rot] of [[13, 0], [14, 90], [15, 180], [16, 270]]) {
      push(rawKey, String(rot), 64, rot);
      console.log(`  raw key ${rawKey} -> rotated ${rot}`);
      await sleep(80);
    }

  }, 'Three questions:\n' +
     '  1. SIZE: of the tiles labelled 64, 72 and 80, which fills its key exactly\n' +
     '     edge to edge, with no black margin AND without bleeding into the next key?\n' +
     '  2. ROTATION: on the four tiles labelled 0/90/180/270, which one has its RED\n' +
     '     SQUARE in the top-left corner? Its label is the correct rotation.\n' +
     '  3. REVERT: does the panel now stay put, or still fall back to its stock screen?'),

  /**
   * Drives the RGB light strip.
   *
   *   led 255 0 0     every LED red
   *   led off         hand the strip back to its built-in breathing effect
   *   led bright 40   strip brightness, 0-100
   *   led chase       a moving dot, to check ordering and that all 24 respond
   *   led rainbow     a hue sweep across the strip
   *   led one 7       light a single index, to identify it by eye
   *   led zones       ring green, front blue, unfitted dark
   *   led probe       walk the strip and record where each index lit up
   *
   * The strip is not one continuous ring: some indices drive LEDs on the
   * front of the unit. Animations take --zone=ring|front|all (default ring)
   * so a chase does not visibly jump off the ring and onto the front. Which
   * index is in which zone is model data; `led probe` measures it.
   */
  led: () => withDock(async dock => {
    dock.connect({ clear: false });
    const mode = positional[0];
    const zone = flag('zone', 'ring');

    if (mode === 'off') { dock.resetLeds(); return; }
    if (mode === 'bright') { dock.setLedBrightness(Number(positional[1] ?? 50)); return; }

    // Every mode below paints the strip, so arm it first. Learned the hard
    // way: the dock dropped off the USB bus mid-probe, watch() reconnected and
    // faithfully re-sent the frame, and the strip came back at brightness 0.
    // The colours were accepted and nothing lit, which reads exactly like a
    // wrong index map. A probe that cannot tell those two apart is useless, so
    // it asserts brightness itself.
    //
    // Then it WAITS, because a brightness write wipes any colour frame that
    // arrives just after it: the device applies LBLIG asynchronously and its
    // render clobbers whatever landed in between (see setLedBrightness and
    // PROTOCOL.md). Without this the first paint of every led command was
    // silently lost and only reappeared on a later keepalive tick -- which is
    // precisely the "frames applied late" ghost that cost us an evening.
    //
    // The usual fix is to send the colour first, but this probe cannot: it has
    // to arm brightness BEFORE it knows what any mode will paint, exactly so a
    // dark strip can be told apart from a wrong index map. So it waits instead.
    dock.setLedBrightness(Number(flag('led-bright', 60)));
    await sleep(200);

    if (mode === 'one') {
      const index = Number(positional[1]);
      const [r, g, b] = [positional[2] ?? 255, positional[3] ?? 255, positional[4] ?? 255].map(Number);
      dock.setLedColors(Array.from({ length: dock.model.ledCount },
        (_, i) => (i === index ? [r, g, b] : [0, 0, 0])));
      console.log(`index ${index} -> rgb(${r}, ${g}, ${b}), everything else off`);
      return;
    }

    // Paints the recorded zones at once, so a wrong entry in the model is
    // obvious: the ring should be entirely green and nothing green should be
    // on the front.
    if (mode === 'zones') {
      const zones = dock.model.ledZones ?? {};
      dock.setLedZones({
        ...(zones.ring ? { ring: [0, 255, 0] } : {}),
        ...(zones.front ? { front: [0, 0, 255] } : {}),
      }, { rest: [0, 0, 0] });
      for (const [name, indices] of Object.entries(zones)) {
        console.log(`  ${name.padEnd(6)} ${indices.length ? indices.join(', ') : '(none recorded)'}`);
      }
      console.log('\nring = GREEN, front = BLUE, dark = off. Anything miscoloured is a wrong entry.');
      return;
    }

    // Lights a chosen set of indices BLUE against the rest of the ring in RED.
    // For settling a single LED's edge assignment: the ones in doubt sit right
    // against a corner gap, where `led corners` can only say which side of the
    // boundary we PUT them, not which side they are actually on. Against a red
    // ring, a blue LED that has strayed onto the wrong edge is unmissable.
    if (mode === 'pick') {
      const picked = String(positional[1] ?? '').split(',')
        .map(n => Number(n.trim())).filter(Number.isInteger);
      if (!picked.length) { console.log('Usage: led pick 3,8,14,19'); return; }
      const ring = new Set(dock.ledIndices('ring'));
      dock.setLedColors(Array.from({ length: dock.model.ledCount }, (_, i) =>
        picked.includes(i) ? [0, 0, 255]      // in question
        : ring.has(i) ? [255, 0, 0]           // the rest of the ring
        : [0, 0, 0]));                        // front LEDs stay out of it
      console.log(`BLUE: ${picked.join(', ')}\nRED:  the rest of the ring\nOFF:  the front LEDs`);
      return;
    }

    // Confirms all four ring corners in one look. Adjacent edges get opposite
    // colours, so every corner is a red/blue boundary: if a boundary sits
    // anywhere but a corner, that edge's index list in the model is wrong.
    if (mode === 'corners') {
      const edges = dock.model.ledEdges;
      if (!edges) { console.log(`${dock.model.name} has no ledEdges recorded`); return; }
      const paint = [[255, 0, 0], [0, 0, 255]];
      // one frame for all four edges, so no half-painted ring is ever visible
      dock.setLedZones(
        Object.fromEntries(Object.keys(edges).map((name, i) => [name, paint[i % 2]])),
        { rest: [0, 0, 0] });
      Object.entries(edges).forEach(([name, indices], i) => {
        console.log(`  ${name.padEnd(7)} ${i % 2 ? 'BLUE ' : 'RED  '} ${indices.join(', ')}`);
      });
      console.log('\nevery colour change should land exactly on a corner, and no edge should');
      console.log('carry a stray LED of the other colour. front LEDs are off on purpose.');
      return;
    }

    // Narrows a band down: gives every index in an inclusive range its own
    // colour and blacks out the rest, so a single look separates them with no
    // counting and nothing else lit to confuse them with.
    if (mode === 'spread') {
      const from = Number(positional[1] ?? 0);
      const to = Number(positional[2] ?? dock.model.ledCount - 1);
      const palette = [
        ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]],
        ['white', [255, 255, 255]], ['magenta', [255, 0, 255]], ['orange', [255, 60, 0]],
      ];
      dock.setLedColors(Array.from({ length: dock.model.ledCount },
        (_, i) => (i >= from && i <= to ? palette[(i - from) % palette.length][1] : [0, 0, 0])));
      console.log('everything off except:\n');
      for (let i = from; i <= to; i++) {
        console.log(`  index ${String(i).padStart(2)}  ${palette[(i - from) % palette.length][0]}`);
      }
      console.log('\nany colour you cannot find is an LED that is not fitted.');
      return;
    }

    // A faster first pass than probe: paint the whole strip in coloured bands
    // of consecutive indices, so ONE look says which index range sits on the
    // front. Only the band that straddles the boundary then needs stepping
    // through one index at a time.
    if (mode === 'bands') {
      const width = Number(flag('width', 4));
      const palette = [
        ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]],
        ['yellow', [255, 200, 0]], ['magenta', [255, 0, 255]], ['cyan', [0, 255, 255]],
        ['white', [255, 255, 255]], ['orange', [255, 60, 0]],
      ];
      const colours = Array.from({ length: dock.model.ledCount }, (_, i) => palette[Math.floor(i / width) % palette.length][1]);
      dock.setLedColors(colours);
      console.log(`bands of ${width} consecutive indices:\n`);
      for (let start = 0; start < dock.model.ledCount; start += width) {
        const end = Math.min(start + width, dock.model.ledCount) - 1;
        console.log(`  index ${String(start).padStart(2)}-${String(end).padStart(2)}  ${palette[Math.floor(start / width) % palette.length][0]}`);
      }
      console.log('\nread off which colours are on the ring and which are on the front.');
      return;
    }

    // Answers "which index is where" the only way it can be answered: light
    // one at a time and have a human say where it appeared. Writes nothing;
    // it prints a ledZones block to paste into src/device/models.js.
    if (mode === 'probe') {
      const found = { ring: [], front: [], dark: [] };
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = q => new Promise(r => rl.question(q, a => r(a.trim().toLowerCase())));

      console.log(`lighting one of ${dock.model.ledCount} LEDs at a time.`);
      console.log('for each one, say where the light appeared:');
      console.log('  r = on the ring    f = on the front    d = nothing lit');
      console.log('  b = go back one    q = stop here\n');

      for (let i = 0; i < dock.model.ledCount; i++) {
        dock.setLedColors(Array.from({ length: dock.model.ledCount },
          (_, j) => (j === i ? [255, 255, 255] : [0, 0, 0])));
        const answer = await ask(`index ${String(i).padStart(2)} > `);
        if (answer === 'q') break;
        if (answer === 'b') {
          for (const list of Object.values(found)) {
            const at = list.indexOf(i - 1);
            if (at !== -1) list.splice(at, 1);
          }
          i = Math.max(-1, i - 2); // the loop's ++ puts us back on the previous index
          continue;
        }
        const zoneFor = { r: 'ring', f: 'front', d: 'dark' }[answer];
        if (!zoneFor) { i -= 1; console.log('  r, f, d, b or q please'); continue; }
        found[zoneFor].push(i);
      }
      rl.close();

      const fmt = list => `[${list.join(', ')}]`;
      console.log('\npaste into the m18 profile in src/device/models.js:\n');
      console.log('    ledZones: {');
      console.log(`      ring: ${fmt(found.ring)},`);
      console.log(`      front: ${fmt(found.front)},`);
      console.log(`      dark: ${fmt(found.dark)},`);
      console.log('    },');
      console.log(`\nring ${found.ring.length}, front ${found.front.length}, dark ${found.dark.length}`);
      dock.setLedColor(0, 0, 0);
      return;
    }

    if (mode === 'chase') {
      const passes = Number(flag('passes', 12));
      const step = Number(flag('ms', 110));
      const length = dock.ledIndices(zone).length;
      if (!length) {
        console.log(`zone "${zone}" has no LEDs recorded in the model, nothing to chase`);
        return;
      }
      console.log(`one lit LED walking ${length} positions of zone "${zone}", ${passes} passes at ${step}ms`);
      console.log('count the distinct positions, and note which end it starts from\n');
      for (let pass = 0; pass < passes; pass++) {
        for (let i = 0; i < length; i++) {
          // rest black, so leftovers outside the zone cannot be mistaken for
          // part of it without needing a separate frame to clear them
          dock.setLedZoneColors(zone, Array.from({ length }, (_, j) =>
            // a dim tail makes the direction of travel obvious
            j === i ? [255, 255, 255] : j === i - 1 ? [40, 40, 40] : [0, 0, 0]),
            { rest: [0, 0, 0] });
          await sleep(step);
        }
        process.stdout.write(`pass ${pass + 1} `);
      }
      console.log('\ndone');
      return;
    }

    if (mode === 'rainbow') {
      // hue across the strip, rotating, so ordering and colour fidelity are
      // both obvious at a glance
      const hue2rgb = h => {
        const f = (n, k = (n + h / 60) % 6) => Math.round(255 * (1 - Math.max(Math.min(k, 4 - k, 1), 0)));
        return [f(5), f(3), f(1)];
      };
      const length = dock.ledIndices(zone).length;
      if (!length) {
        console.log(`zone "${zone}" has no LEDs recorded in the model, nothing to sweep`);
        return;
      }
      for (let t = 0; t < 120; t++) {
        dock.setLedZoneColors(zone, Array.from({ length },
          (_, i) => hue2rgb(((i / length) * 360 + t * 6) % 360)), { rest: [0, 0, 0] });
        await sleep(50);
      }
      return;
    }

    const [r, g, b] = [positional[0], positional[1], positional[2]].map(Number);
    if ([r, g, b].some(Number.isNaN)) {
      console.log('Usage: led <r> <g> <b> | led off | led bright <0-100> | led one <index> [r g b]\n       | led chase | led rainbow | led zones | led probe   (animations take --zone=ring|front|all)');
      return;
    }
    console.log(`all ${dock.model.ledCount} LEDs -> rgb(${r}, ${g}, ${b})`);
    dock.setLedColor(r, g, b);
  }, 'LED command sent.'),

  /** Just connect and log key presses, changing nothing on screen. */
  listen: () => withDock(dock => {
    dock.connect({ clear: false });
  }, 'Listening for key presses. Press each button one at a time.'),

  /** Sanity check that normal label tiles render and push. */
  demo: () => withDock(async dock => {
    const size = Number(flag('size', dock.model.keyWidth));
    const rot = Number(flag('rot', dock.model.keyRotation));
    // just enough to show text rendering and the key map working together
    const labels = Array.from({ length: dock.model.keyCount }, (_, i) => `Key ${i}`);
    dock.connect();
    dock.setBrightness(80);
    for (let i = 0; i < labels.length; i++) {
      const tile = rotateCanvas(textTile(labels[i], { width: size, height: size }), rot);
      dock.setKeyImage(i, encodeJpeg(tile, dock.model.maxImageBytes).buf);
      await sleep(60);
    }
  }, 'Labels pushed. Index 0 should be the TOP-LEFT key.'),
};

if (!commands[command]) {
  console.log(`Usage: node tools/dock.js <command> [flags]

  info                    HID interfaces and report sizes
  blink                   ramp brightness so you can see it respond
  bright <0-100>          set brightness
  clear [rawId]           clear one key, or all
  calibrate               numbered tiles on every key, answers the raw id > position map
  sizes                   sweep candidate key image sizes, one per key
  fit                     decisive round: 3 sizes + 4 rotations + refresh keepalive
  rotations               sweep 0/90/180/270 on the first four keys
  demo                    write a numbered label to every key
  listen                  log key presses without touching the screen

LED strip (24 addressable LEDs: the ring, plus a group on the front):
  led <r> <g> <b>         set the whole strip
  led off                 restore the built-in breathing animation
  led bright <0-100>      strip brightness
  led chase               one lit LED walking a zone (--zone, --passes, --ms)
  led one <i> [r g b]     light a single LED index, everything else off
  led zones               paint the recorded zones: ring green, front blue
  led bands               paint coloured bands of indices, fast first pass
  led spread <a> <b>      one colour per index across a range, rest off
  led corners             adjacent ring edges red/blue, checks all 4 corners
  led pick 3,8,14,19      chosen indices blue against a red ring
  led probe               walk the strip and record ring vs front per index
  led rainbow             rotating hue sweep

Flags:
  --size=100              key image size in pixels
  --rot=180               rotation applied before sending
  --to=18                 highest raw key id to try (calibrate)
  --list=64,72,...        sizes to sweep (sizes)
  --brightness=80
  --keepalive=<kind>      brightness (default) | connect | refresh | none
                          which command to poke the dock with so it does not
                          revert to its stock screen when idle
  --keepalive-ms=8000     how often to poke; 8s is verified to work
  --keepalive-leds=off    do not re-send the LED colours on each poke; use
                          this when investigating the strip itself
  --zone=ring|front|all   which LED group to animate (default ring)
  --width=4               indices per colour band (led bands)
  --led-bright=60         strip brightness, asserted 200ms before any LED
                          paint so it cannot wipe the frame (see PROTOCOL.md)
  --raw                   dump raw input reports
`);
  process.exit(1);
}

Promise.resolve(commands[command]()).catch(err => { console.error(err.message); process.exit(1); });
