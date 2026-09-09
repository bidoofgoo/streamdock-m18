//
// Node-side key image rendering: create a canvas, draw with the shared code,
// rotate if the panel needs it, encode to JPEG under the device byte budget.
//
import { createCanvas } from '@napi-rs/canvas';
import { drawCalibrationTile, drawTextTile } from '../icons/draw.js';

/**
 * Encodes to JPEG, dropping quality until it fits the byte budget.
 * Throws rather than sending something the device will reject outright.
 */
export function encodeJpeg(canvas, maxBytes) {
  for (const quality of [92, 85, 75, 65, 55, 45, 35, 25]) {
    const buf = canvas.toBuffer('image/jpeg', quality);
    if (buf.length <= maxBytes) return { buf, quality };
  }
  throw new Error(`cannot compress under ${maxBytes} bytes`);
}

/** Rotates a canvas by 0, 90, 180 or 270 degrees, returning a new canvas. */
export function rotateCanvas(src, degrees) {
  const deg = ((degrees % 360) + 360) % 360;
  if (deg === 0) return src;
  const swap = deg === 90 || deg === 270;
  const out = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

function render(draw, options) {
  const canvas = createCanvas(options.width, options.height);
  draw(canvas.getContext('2d'), options);
  return canvas;
}

export const calibrationTile = (label, options) =>
  render(ctx => drawCalibrationTile(ctx, label, options), options);

export const textTile = (text, options) =>
  render(ctx => drawTextTile(ctx, text, options), options);
