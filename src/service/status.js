//
// What the dock shows when no app is driving it.
//
// The daemon owns the panel only while nothing else does. As soon as a client
// paints a key, the screen is theirs and the daemon never touches it again
// until every client has gone; the strip is tracked separately, so an app that
// only uses the LEDs keeps the helpful screen.
//
// The point is that the device answers "is this thing working?" by itself.
// Without it, a blank panel means any of: daemon not running, dock unplugged,
// app not connected, app connected but silent, or app crashed mid-paint.
//
import { textTile, rotateCanvas, encodeJpeg } from '../device/icons.js';

const INK = {
  waiting: { color: '#3a2a12', textColor: '#f0b046' },
  ready: { color: '#12293a', textColor: '#46b4f0' },
  hint: { color: '#101820', textColor: '#5f6f7f' },
};

/**
 * A screen is rows of words, one word per key, reading left to right from the
 * top-left key. A 64x64 key holds about one short word legibly, so a sentence
 * spread across the grid reads far better than a paragraph squeezed onto one
 * key. Rows are padded out with blanks, so a short row leaves the rest of its
 * row dark rather than wrapping.
 */
const SCREENS = {
  // Nothing is connected. The port is the one thing the person standing in
  // front of the dock cannot guess, so it gets a row.
  waiting: port => ({
    leds: [255, 110, 0],
    rows: [
      [['waiting', INK.waiting], ['for', INK.waiting], ['an app', INK.waiting]],
      [['on port', INK.hint], [String(port), INK.hint]],
    ],
  }),

  // An app is connected but has not painted anything yet. Separating this from
  // "waiting" is the whole value: it distinguishes "your app is not talking to
  // me" from "your app is talking to me but has not drawn anything".
  ready: () => ({
    leds: [0, 90, 255],
    rows: [
      [['waiting', INK.ready], ['for', INK.ready], ['input', INK.ready]],
      [['app', INK.hint], ['connected', INK.hint]],
    ],
  }),
};

/** Renders one label to a key, at the model's size and rotation. */
function paintKey(dock, index, label, ink) {
  const tile = textTile(label, { width: dock.model.keyWidth, height: dock.model.keyHeight, ...ink });
  dock.setKeyImage(index, encodeJpeg(rotateCanvas(tile, dock.model.keyRotation), dock.model.maxImageBytes).buf);
}

/**
 * Paints a status screen.
 *
 * @param state  'waiting' or 'ready'
 * @param leds   false to leave the strip alone (an app is using it)
 */
export function paintStatus(dock, state, { port = 5548, leds = true } = {}) {
  const screen = SCREENS[state];
  if (!screen) throw new Error(`unknown status screen "${state}"`);
  const { rows, leds: color } = screen(port);

  dock.clearAll();
  rows.forEach((words, row) => {
    words.forEach(([label, ink], column) => {
      const index = row * dock.model.keyCols + column;
      if (column < dock.model.keyCols && index < dock.model.keyCount) {
        paintKey(dock, index, label, ink);
      }
    });
  });

  if (leds && dock.model.hasRgbLed) {
    // Dim on purpose: this is a status light, not decoration, and it must not
    // be the brightest thing on someone's desk while they work.
    dock.setLedBrightness(25);
    dock.setLedZoneColors('ring', color, { rest: [0, 0, 0] });
  }
}

export const STATUS_STATES = Object.keys(SCREENS);
