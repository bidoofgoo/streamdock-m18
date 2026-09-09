//
// The daemon's command vocabulary, kept separate from the socket so it can be
// tested against a fake HID handle with no hardware and no networking.
//
// Every command is a JSON object with a "cmd" field. Unknown commands and bad
// arguments throw, and the daemon turns that into an error line rather than
// dropping the client, because a sketch under development WILL send nonsense
// and losing the connection for it would be miserable to debug.
//
import { textTile, rotateCanvas, encodeJpeg } from '../device/icons.js';

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const int = (value, name, { min = -Infinity, max = Infinity }) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a number, got ${JSON.stringify(value)}`);
  if (n < min || n > max) throw new RangeError(`${name} must be ${min}..${max}, got ${n}`);
  return Math.round(n);
};

const rgb = (value, name) => {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${name} must be [r, g, b], got ${JSON.stringify(value)}`);
  }
  return value.map((c, i) => int(c, `${name}[${i}]`, { min: 0, max: 255 }));
};

/** Renders a label tile for one key, at the model's size and rotation. */
function labelJpeg(dock, { label = '', color, textColor }) {
  const tile = textTile(String(label), {
    width: dock.model.keyWidth,
    height: dock.model.keyHeight,
    ...(color ? { color } : {}),
    ...(textColor ? { textColor } : {}),
  });
  return encodeJpeg(rotateCanvas(tile, dock.model.keyRotation), dock.model.maxImageBytes).buf;
}

/**
 * Applies one command to the dock.
 *
 * `dock` is a connected StreamDock. Callers must handle the device being
 * absent themselves; this layer assumes it has one.
 */
export function applyCommand(dock, message) {
  const keyIndex = () => int(message.index, 'index', { min: 0, max: dock.model.keyCount - 1 });

  switch (message.cmd) {
    // --- keys ------------------------------------------------------------
    case 'key':
      dock.setKeyImage(keyIndex(), labelJpeg(dock, message));
      return { ok: true };

    case 'keyImage': {
      const index = keyIndex();
      const jpeg = Buffer.from(String(message.jpeg ?? ''), 'base64');
      if (!jpeg.length) throw new TypeError('keyImage needs a base64 "jpeg" field');
      // The device blits into a fixed per-key framebuffer, so an oversized or
      // non-JPEG payload does not fail cleanly: it corrupts NEIGHBOURING keys.
      // Refusing here is much kinder than letting the panel smear.
      if (!JPEG_MAGIC.every((b, i) => jpeg[i] === b)) {
        throw new TypeError('keyImage payload is not a JPEG (must start ff d8 ff)');
      }
      if (jpeg.length > dock.model.maxImageBytes) {
        throw new RangeError(`keyImage is ${jpeg.length} bytes, device limit is ${dock.model.maxImageBytes}`);
      }
      dock.setKeyImage(index, jpeg);
      return { ok: true, bytes: jpeg.length };
    }

    case 'clear':
      if (message.index === undefined) { dock.clearAll(); return { ok: true }; }
      dock.clearKey(dock.model.imageKeyIds[keyIndex()]);
      return { ok: true };

    case 'brightness':
      dock.setBrightness(int(message.value, 'value', { min: 0, max: 100 }));
      return { ok: true };

    // --- LEDs ------------------------------------------------------------
    case 'led': {
      const zone = String(message.zone ?? 'all');
      // ledIndices throws with the list of known zone names, which is exactly
      // the error a sketch author wants to read.
      dock.ledIndices(zone);
      dock.setLedZoneColors(zone, rgb(message.color, 'color'),
        message.rest ? { rest: rgb(message.rest, 'rest') } : undefined);
      return { ok: true };
    }

    case 'ledFrame': {
      if (!Array.isArray(message.colors)) throw new TypeError('ledFrame needs a "colors" array');
      dock.setLedColors(message.colors.map((c, i) => rgb(c, `colors[${i}]`)));
      return { ok: true };
    }

    case 'ledBrightness':
      dock.setLedBrightness(int(message.value, 'value', { min: 0, max: 100 }));
      return { ok: true };

    case 'ledOff':
      dock.resetLeds();
      return { ok: true };

    default:
      throw new TypeError(`unknown command ${JSON.stringify(message.cmd)}`);
  }
}

/** What a client is told about the device when it connects. */
export function describe(dock) {
  return {
    device: dock.model.name,
    keys: dock.model.keyCount,
    aux: dock.model.auxKeyCount,
    keyWidth: dock.model.keyWidth,
    keyHeight: dock.model.keyHeight,
    maxImageBytes: dock.model.maxImageBytes,
    leds: dock.model.hasRgbLed ? dock.model.ledCount : 0,
    ledZones: Object.keys(dock.model.ledZones ?? {}),
    ledEdges: Object.keys(dock.model.ledEdges ?? {}),
  };
}
