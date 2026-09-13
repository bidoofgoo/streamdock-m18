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
  // One colour per row, run edge to edge: a row is a solid band, not a few lit
  // tiles with dark gaps after them. The hint row keeps its own darker colour,
  // so the headline reads first and the supporting detail sits under it.
  waiting: { color: '#3a2a12', textColor: '#f0b046' },
  ready: { color: '#12293a', textColor: '#46b4f0' },
  hint: { color: '#101820', textColor: '#5f6f7f' },
};

/**
 * A screen is rows of words, one word per key, reading left to right from the
 * top-left key. A 64x64 key holds one short word legibly, so a sentence spread
 * across the grid reads far better than a paragraph squeezed onto one key -
 * which is why every entry here is a single word, never a phrase. Short rows
 * are padded out with blank keys in the row's own colour, so the band runs the
 * full width of the panel instead of trailing off into dark keys.
 */
const SCREENS = {
  // Nothing is connected. The port is the one thing the person standing in
  // front of the dock cannot guess, so it gets a row.
  waiting: port => ({
    leds: [255, 110, 0],
    rows: [
      { ink: INK.waiting, words: ['waiting', 'for', 'a', 'client'] },
      { ink: INK.hint, words: ['on', 'port', String(port)] },
    ],
  }),

  // An app is connected but has not painted anything yet. Separating this from
  // "waiting" is the whole value: it distinguishes "your app is not talking to
  // me" from "your app is talking to me but has not drawn anything".
  ready: () => ({
    leds: [0, 90, 255],
    rows: [
      { ink: INK.ready, words: ['waiting', 'for', 'input'] },
      { ink: INK.hint, words: ['app', 'connected'] },
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
  rows.forEach(({ words, ink }, row) => {
    for (let column = 0; column < dock.model.keyCols; column += 1) {
      const index = row * dock.model.keyCols + column;
      if (index < dock.model.keyCount) paintKey(dock, index, words[column] ?? '', ink);
    }
  });

  if (leds && dock.model.hasRgbLed) {
    // Colour BEFORE brightness. A brightness render reads the device's frame
    // buffer, so a colour already in it is picked up, while one arriving just
    // after is wiped. See setLedBrightness. In practice the brightness here
    // never changes after the first paint and so is skipped entirely, but the
    // order is what makes that safe rather than lucky.
    dock.setLedZoneColors('ring', color, { rest: [0, 0, 0] });
    // Dim on purpose: this is a status light, not decoration, and it must not
    // be the brightest thing on someone's desk while they work.
    dock.setLedBrightness(25);
  }
}

export const STATUS_STATES = Object.keys(SCREENS);
