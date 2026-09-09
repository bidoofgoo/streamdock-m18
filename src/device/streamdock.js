//
// Stream Dock driver.
//
// Talks to the dock's vendor-defined HID interface (usage page 0xFFA0). The
// device also exposes a plain keyboard interface, which we deliberately ignore.
//
// Two hard-won constraints shape this file:
//
//   1. Output reports must be EXACTLY the size declared in the report
//      descriptor (1024 bytes for our model), plus one leading report ID byte
//      that hidapi strips. Anything else is silently discarded by the device.
//
//   2. "DIS" is disconnect, not wake. The panel only comes alive after
//      DIS > CONNECT. Sending DIS on its own leaves it dark.
//
import { EventEmitter } from 'node:events';
import HID from 'node-hid';
import { findModel } from './models.js';

const VENDOR_USAGE_PAGE = 0xffa0;

const PREFIX = [0x43, 0x52, 0x54, 0x00, 0x00]; // "CRT\0\0"
const ACK_OK = Buffer.from([0x41, 0x43, 0x4b, 0x00, 0x00, 0x4f, 0x4b, 0x00]); // "ACK\0\0OK\0"

const CMD = {
  connect: [...PREFIX, 0x43, 0x4f, 0x4e, 0x4e, 0x45, 0x43, 0x54],
  disconnect: [...PREFIX, 0x44, 0x49, 0x53],
  hangUp: [...PREFIX, 0x48, 0x41, 0x4e],
  commit: [...PREFIX, 0x53, 0x54, 0x50],
  close: [...PREFIX, 0x43, 0x4c, 0x45, 0x00, 0x44, 0x43],
  brightness: pct => [...PREFIX, 0x4c, 0x49, 0x47, 0x00, 0x00, pct],
  clear: keyId => [...PREFIX, 0x43, 0x4c, 0x45, 0x00, 0x00, 0x00, keyId],
  beginKeyImage: (size, keyId) =>
    [...PREFIX, 0x42, 0x41, 0x54, 0x00, 0x00, (size >> 8) & 0xff, size & 0xff, keyId],
  // --- RGB light strip ---
  //
  // These are absent from every community reverse engineering and from
  // Mirabox's published source. They were recovered by disassembling the
  // precompiled libtransport_arm64.dylib that ships with the vendor SDK:
  // Transport::setLedBrightness, ::setLedColor and ::resetLedColor each build
  // a 10 byte header and hand it to the same transport as everything else.
  ledBrightness: value => [...PREFIX, 0x4c, 0x42, 0x4c, 0x49, 0x47, value],  // LBLIG
  ledColors: rgb => [...PREFIX, 0x53, 0x45, 0x54, 0x4c, 0x42, ...rgb],       // SETLB
  ledReset: [...PREFIX, 0x44, 0x45, 0x4c, 0x45, 0x44],                       // DELED

  beginScreenImage: size =>
    [...PREFIX, 0x4c, 0x4f, 0x47,
      (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, 0x01],
};

const CLEAR_ALL = 0xff;

/**
 * Emits:
 *   'key'   { index, keyId, state, aux }  index is -1 if the id is unknown
 *   'input' Buffer                        every raw input report
 *   'error' Error
 */
export class StreamDock extends EventEmitter {
  #hid;
  #ledFrame = null; // last frame sent, so a zone write can leave the other zones alone
  #closed = false;
  #heartbeat = null;

  /** Last brightness we set, so a keepalive can re-assert it. */
  brightness = 80;

  constructor(hid, model) {
    super();
    this.#hid = hid;
    this.model = model;
    this.#hid.on('data', buf => this.#onInput(buf));
    this.#hid.on('error', err => {
      // node-hid surfaces an unplug as a read error and the read loop then
      // stays dead, so treat any read error as a disconnect rather than
      // letting it take the process down.
      this.#closed = true;
      this.stopKeepalive();
      this.emit('disconnect', err);
    });
  }

  /** Finds and opens the first supported dock. Throws if none is attached. */
  static open() {
    const candidates = HID.devices().filter(d => d.usagePage === VENDOR_USAGE_PAGE && findModel(d.vendorId, d.productId));
    if (candidates.length === 0) {
      const err = new Error('No supported Stream Dock found. Is it plugged in?');
      err.code = 'ENODOCK';
      throw err;
    }
    const info = candidates[0];
    return new StreamDock(new HID.HID(info.path), findModel(info.vendorId, info.productId));
  }

  /**
   * Opens the dock and keeps it open across unplugs.
   *
   * Calls onConnect(dock) every time a device appears, including the first
   * time, so callers put their setup (brightness, key images, listeners) in
   * there and get it re-applied automatically on replug. Returns a stop().
   *
   * Never throws for a device that is absent or busy; it keeps polling and
   * reports each new reason once through onError.
   */
  static watch(onConnect, { pollMs = 1000, onLost, onError } = {}) {
    let current = null;
    let stopped = false;
    let lastOpenError = null;

    const tick = () => {
      if (stopped || current) return;
      try {
        current = StreamDock.open();
      } catch (err) {
        // Every failure here is worth retrying rather than fatal. The dock may
        // not be plugged in yet, or another process may still hold it open;
        // hidapi grants exclusive access, so a stale CLI blocks us until it
        // exits. Report each distinct reason once so it is not a silent hang.
        if (err.message !== lastOpenError) {
          lastOpenError = err.message;
          onError?.(err);
        }
        return;
      }
      lastOpenError = null;
      current.on('disconnect', err => {
        const lost = current;
        current = null;
        onLost?.(err);
        lost.close();
      });
      onConnect(current);
    };

    tick();
    // Deliberately NOT unref'd: this timer is what keeps the process alive
    // while waiting for the dock. Unref'ing it lets Node exit immediately,
    // because an unresolved promise alone does not hold the event loop open.
    const timer = setInterval(tick, pollMs);

    return () => {
      stopped = true;
      clearInterval(timer);
      current?.close();
    };
  }

  static list() {
    return HID.devices().filter(d => d.vendorId === 0x5548);
  }

  // --- wire level -----------------------------------------------------------

  /**
   * Sends a raw command body, for exploring commands this driver does not
   * model yet. Everything in CMD is a plain byte array, so pass one of those
   * or build your own; padding and the report ID byte are handled.
   *
   * Exists because this is a reverse engineering tool: the vendor's string
   * table lists commands (LMOD, COLOR, CPOS, BGPIC, BGCLE, QUCMD) whose
   * behaviour is unknown, and finding out requires sending them. Prefer a
   * named method for anything already understood.
   */
  sendRaw(body) {
    return this.#send(body);
  }

  /** Pads to exactly outputReportSize and prepends the report ID byte. */
  #send(body) {
    if (this.#closed) throw new Error('device is closed');
    const report = Buffer.alloc(this.model.outputReportSize + 1);
    Buffer.from(body).copy(report, 1);
    return this.#hid.write(report);
  }

  #onInput(buf) {
    this.emit('input', buf);
    if (!buf.subarray(0, ACK_OK.length).equals(ACK_OK)) return;

    const keyId = buf[9];
    const state = buf[10];
    // A key event carries a non-zero id; a bare ACK does not.
    if (!keyId) return;

    // NOTE: input uses inputKeyIds, output uses imageKeyIds. They differ.
    const index = this.model.inputKeyIds.indexOf(keyId);
    const auxIndex = this.model.auxKeyIds.indexOf(keyId);
    this.emit('key', {
      index: index >= 0 ? index : auxIndex >= 0 ? this.model.keyCount + auxIndex : -1,
      keyId,
      state,
      aux: auxIndex >= 0,
    });
  }

  // --- session --------------------------------------------------------------

  /**
   * Brings the panel up. The disconnect first is not redundant: it resets any
   * half-open session left behind by a previous process that did not close
   * cleanly, which is otherwise very easy to get stuck in.
   */
  connect({ clear = true } = {}) {
    this.#send(CMD.disconnect);
    this.#send(CMD.connect);
    if (clear) this.#send(CMD.clear(CLEAR_ALL));
    this.#send(CMD.commit);
  }

  /**
   * Periodically pokes the device so it does not revert to its stock screen
   * when the host goes quiet. The dock was observed doing exactly that.
   *
   * Which poke actually works is not documented anywhere and no reference
   * implementation sends one at all, so the command is selectable:
   *
   *   'brightness' re-asserts the current brightness. VERIFIED 2026-08-28 to
   *                stop the idle revert completely at an 8s interval. The
   *                default, and the reason it works is presumably that the
   *                backlight is the thing going to sleep, so this pokes it
   *                directly.
   *   'refresh'    a bare STP commit. Gentlest, and observed NOT to be enough.
   *   'connect'    re-runs the session handshake. Strongest and most invasive;
   *                unnecessary now that brightness is known to work.
   *
   * Note on an earlier false alarm: a device once dropped off the USB bus
   * while a 2s CONNECT heartbeat ran, and this was initially blamed on the
   * heartbeat. It later dropped off again with no heartbeat at all, so the
   * two are unrelated. Reconnection is handled by watch() regardless.
   */
  startKeepalive(kind = 'brightness', intervalMs = 8000) {
    this.stopKeepalive();
    const poke = {
      connect: () => this.#send(CMD.connect),
      refresh: () => this.#send(CMD.commit),
      brightness: () => this.setBrightness(this.brightness),
    }[kind];
    if (!poke) throw new Error(`unknown keepalive kind "${kind}"`);

    this.#heartbeat = setInterval(() => {
      try { poke(); } catch { this.stopKeepalive(); }
    }, intervalMs);
    this.#heartbeat.unref?.();
  }

  stopKeepalive() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  /**
   * Commits pending state. Also the gentlest thing we can send periodically to
   * find out whether the panel reverts to its stock screen when the host goes
   * quiet, which it was observed doing on 2026-08-28.
   */
  refresh() {
    this.#send(CMD.commit);
  }

  /** @param pct 0-100. The device wants a percentage, not a 0-255 level. */
  setBrightness(pct) {
    this.brightness = Math.min(100, Math.max(0, Math.round(pct)));
    this.#send(CMD.brightness(this.brightness));
    this.#send(CMD.commit);
  }

  clearAll() {
    this.#send(CMD.clear(CLEAR_ALL));
    this.#send(CMD.commit);
  }

  clearKey(keyId) {
    this.#send(CMD.clear(keyId));
    this.#send(CMD.commit);
  }

  /**
   * Pushes a JPEG to one key by its RAW device id (not grid index).
   * The header announces the length as a big-endian uint16, then the bytes
   * follow as raw full-size pages with no command prefix.
   */
  setKeyImageRaw(keyId, jpeg) {
    if (jpeg.length > this.model.maxImageBytes) {
      throw new Error(`image is ${jpeg.length} bytes, device limit is ${this.model.maxImageBytes}`);
    }
    this.#send(CMD.beginKeyImage(jpeg.length, keyId));
    const page = this.model.outputReportSize;
    for (let offset = 0; offset < jpeg.length; offset += page) {
      this.#send(jpeg.subarray(offset, Math.min(offset + page, jpeg.length)));
    }
    this.#send(CMD.commit);
  }

  /** Pushes a JPEG to a key by grid index (0 = top left). */
  setKeyImage(index, jpeg) {
    const keyId = this.model.imageKeyIds[index];
    if (keyId === undefined) throw new RangeError(`no key at index ${index}`);
    this.setKeyImageRaw(keyId, jpeg);
  }

  // --- RGB light strip ---------------------------------------------------

  #assertLeds() {
    if (!this.model.hasRgbLed) throw new Error(`${this.model.name} has no RGB light strip`);
  }

  /** @param value 0-100, same percentage scale as the screen brightness. */
  setLedBrightness(value) {
    this.#assertLeds();
    this.#send(CMD.ledBrightness(Math.min(100, Math.max(0, Math.round(value)))));
  }

  /** Sets every LED on the strip to one colour. */
  setLedColor(r, g, b) {
    this.#assertLeds();
    const rgb = [];
    for (let i = 0; i < this.model.ledCount; i++) rgb.push(r, g, b);
    this.#ledFrame = Array.from({ length: this.model.ledCount }, () => [r, g, b]);
    this.#send(CMD.ledColors(rgb));
  }

  /**
   * Sets the strip per-LED. Accepts an array of [r, g, b].
   * Short arrays are padded with black, long ones truncated, so a caller
   * cannot accidentally run past the strip and into whatever follows it.
   */
  setLedColors(colors) {
    this.#assertLeds();
    const frame = [];
    for (let i = 0; i < this.model.ledCount; i++) {
      const [r = 0, g = 0, b = 0] = colors[i] ?? [];
      frame.push([r & 0xff, g & 0xff, b & 0xff]);
    }
    this.#ledFrame = frame;
    this.#send(CMD.ledColors(frame.flat()));
  }

  // --- Zones -------------------------------------------------------------
  //
  // One SETLB write covers all 24 LEDs, but they are not all in the same
  // place: on the M18 the strip spans both the ring around the unit and a
  // separate group on the front. Animating "the ring" therefore means
  // animating a subset of indices while leaving the rest of the frame alone,
  // which is why every zone write merges into a retained frame instead of
  // building a fresh one.

  /**
   * The device indices making up a named zone, in strip order.
   *
   * Resolves both ledZones (the physical groups, which partition the strip)
   * and ledEdges (named sub-ranges of the ring, which do not), so a caller
   * can ask for 'ring', 'front' or 'top' without caring which kind it is.
   * 'all' is every index whether or not the model names any groups.
   */
  ledIndices(zone = 'all') {
    this.#assertLeds();
    if (zone === 'all') return Array.from({ length: this.model.ledCount }, (_, i) => i);
    const indices = this.model.ledZones?.[zone] ?? this.model.ledEdges?.[zone];
    if (!indices) {
      const known = ['all', ...Object.keys(this.model.ledZones ?? {}), ...Object.keys(this.model.ledEdges ?? {})];
      throw new Error(`unknown LED zone "${zone}" (known: ${known.join(', ')})`);
    }
    return indices.filter(i => i >= 0 && i < this.model.ledCount);
  }

  /**
   * Writes several zones and sends the result as ONE frame.
   *
   * `map` is { zoneName: colors }, where colors is either a single [r, g, b]
   * for the whole zone, or an array of [r, g, b] indexed by POSITION WITHIN
   * THE ZONE, not by device index; that way a caller animating the ring can
   * count 0..ringLength-1 without knowing where those LEDs sit in the strip.
   *
   * `rest` is what everything outside the named zones becomes. Omit it to
   * leave the rest of the strip as it was.
   *
   * Composing locally and writing once keeps a multi-zone paint atomic: no
   * intermediate frame ever reaches the strip, so nobody sees a half-painted
   * ring. (This was originally written to dodge a suspected problem with
   * back-to-back frames. That theory is withdrawn - see PROTOCOL.md - since
   * chase animations send frames continuously and work fine. One write is
   * still the better shape, so it stays.)
   */
  setLedZones(map, { rest } = {}) {
    this.#assertLeds();
    const frame = rest
      ? Array.from({ length: this.model.ledCount }, () => [...rest])
      : this.ledFrame();
    for (const [zone, colors] of Object.entries(map)) {
      const single = Array.isArray(colors) && typeof colors[0] === 'number';
      this.ledIndices(zone).forEach((deviceIndex, positionInZone) => {
        const [r = 0, g = 0, b = 0] = (single ? colors : colors[positionInZone]) ?? [];
        frame[deviceIndex] = [r & 0xff, g & 0xff, b & 0xff];
      });
    }
    this.setLedColors(frame);
  }

  /** Writes one zone and leaves the rest of the strip as it was. */
  setLedZoneColors(zone, colors, options) {
    this.setLedZones({ [zone]: colors }, options);
  }

  /** A copy of the last frame sent, black if nothing has been sent yet. */
  ledFrame() {
    this.#assertLeds();
    return Array.from({ length: this.model.ledCount },
      (_, i) => [...(this.#ledFrame?.[i] ?? [0, 0, 0])]);
  }

  /** Hands the strip back to its built-in breathing animation. */
  resetLeds() {
    this.#assertLeds();
    this.#ledFrame = null; // the built-in effect owns the strip now, we no longer know its state
    this.#send(CMD.ledReset);
  }

  close() {
    if (this.#closed) return;
    this.stopKeepalive();
    try {
      this.#send(CMD.close);
      this.#send(CMD.hangUp);
    } catch { /* device may already be gone */ }
    this.#closed = true;
    try { this.#hid.close(); } catch { /* ignore */ }
  }
}

export { CMD, ACK_OK, CLEAR_ALL };
