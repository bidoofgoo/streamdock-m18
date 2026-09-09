//
// Key artwork, drawn against a plain 2D context.
//
// Deliberately free of any canvas *creation*, so the identical drawing code
// runs under @napi-rs/canvas in Node and under the real canvas in a browser.
// Only the surrounding wrappers differ per platform.
//

/** Shrinks the font until the text fits, rather than letting it overflow. */
function fitFont(ctx, text, width, startSize) {
  let size = startSize;
  do {
    ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
    size -= 1;
  } while (size > 7 && ctx.measureText(text).width > width * 0.88);
}

/**
 * Calibration artwork: a big label plus an unmistakable TOP-LEFT marker.
 *
 * This is the tool for bringing up an unknown device. Push it at several
 * candidate sizes and rotations, then read the panel:
 *
 *   - where the red marker lands gives you the panel rotation
 *   - whether the tile fills its key, without bleeding into the next one,
 *     gives you the key size
 *   - the label tells you which raw key id drives which physical key
 *
 * See PROTOCOL.md section 6, and `tools/dock.js fit`.
 */
export function drawCalibrationTile(ctx, label, { width, height, background = '#101820' }) {
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#2f6f4f';
  ctx.lineWidth = Math.max(2, width * 0.03);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth);

  const marker = Math.round(width * 0.26);
  ctx.fillStyle = '#e03131';
  ctx.fillRect(0, 0, marker, marker);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitFont(ctx, String(label), width, Math.round(height * 0.42));
  ctx.fillText(String(label), width / 2, height * 0.58);
}

/**
 * A plain text key: a label centred on a colour.
 *
 * Intentionally minimal. It exists so the CLI has something to demonstrate
 * with, and as a starting point to copy; real applications will want their own
 * artwork rather than this.
 */
export function drawTextTile(ctx, text, { width, height, color = '#1f2933', textColor = '#ffffff' }) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // wrap on a space so two-word labels stay legible on a 64px key
  const words = String(text).split(' ');
  const lines = words.length > 1 && width < 96 ? [words[0], words.slice(1).join(' ')] : [String(text)];

  fitFont(ctx, lines.reduce((a, b) => (a.length > b.length ? a : b), ''), width, Math.round(height * 0.26));
  const lineHeight = height * 0.24;
  const top = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, width / 2, top + i * lineHeight));
}
