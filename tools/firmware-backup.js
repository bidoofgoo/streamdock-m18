#!/usr/bin/env node
//
// Reads the whole SPI NOR flash of a Stream Dock M18 to a file, over USB, using
// the ArtInChip upgrade tool that ships with the vendor's own VSD Craft install.
// See FIRMWARE-BACKUP.md for what this does, why, and the risks.
//
// Nothing here writes flash. Every upgcmd call goes through allow(), which only
// lets through read commands, a RAM fill inside a scratch window, and three
// shell commands (spinor init, spinor read, reset). Windows only, because the
// vendor tool is.
//
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import HID from 'node-hid';
import { StreamDock } from '../src/device/streamdock.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => argv.includes(`--${name}`);

if (has('help') || argv.length === 0) {
  console.log(`usage: npm run firmware-backup -- <out.bin> [options]

  --upgcmd=<path>   upgcmdHid.exe (default: VSD Craft's UpDateToolV3 folder)
  --twice           read everything a second time and require identical results
  --keep-upgrade    stay in upgrade mode afterwards instead of resetting

Reads the full 16 MB flash. Read-only. See FIRMWARE-BACKUP.md first.`);
  process.exit(argv.length === 0 ? 1 : 0);
}

const OUT = resolve(argv.find(a => !a.startsWith('--')));
const UPGCMD = flag('upgcmd', 'C:\\Program Files (x86)\\VSD Craft\\UpDateToolV3\\upgcmdHid.exe');

const UPGRADE_VID = 0x33c3;       // ArtInChip upgrade mode (seen as 33C3:8899 in HID mode)
const FLASH_SIZE = 0x1000000;     // 16 MB; a mirror check below catches a smaller part
const CHUNK = 0x40000;            // 256 KB per round trip, well under a second each
const RAM = 0x40100000;           // PSRAM scratch window, verified unused by the bootloader
const SENTINEL = 0xa5;
const APPNEW = [0x43, 0x52, 0x54, 0x00, 0x00, 0x41, 0x50, 0x50, 0x4e, 0x45, 0x57]; // "CRT\0\0APPNEW"

// Partition map as reported by `upgcmdHid lspart spi-nor` on a VSDM18 unit.
const PARTS = [
  ['spl', 0x000000, 0x080000],
  ['env', 0x080000, 0x020000],
  ['env_r', 0x0a0000, 0x020000],
  ['os', 0x0c0000, 0x200000],
  ['rodata', 0x2c0000, 0xa00000],
  ['data', 0xcc0000, 0x100000],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => '0x' + n.toString(16);

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

/**
 * The only gate to upgcmd. The vendor tool can erase and write flash (image,
 * write, spinor erase/write, efuse, jtag), so everything not explicitly a read
 * is refused here rather than trusted to the call sites.
 */
function allow(args) {
  const [cmd, ...rest] = args;
  if (['-l', 'lspart', 'log', 'read', 'readl'].includes(cmd)) return;
  if (cmd === 'fill') {
    const [addr, len] = rest.map(Number);
    if (addr >= RAM && addr + len <= RAM + CHUNK) return;
  }
  if (cmd === 'shcmd') {
    const sh = rest.join(' ');
    if (/^spinor init \d$/.test(sh) || /^spinor read 0x[0-9a-f]+ 0x[0-9a-f]+ 0x[0-9a-f]+$/.test(sh) || sh === 'reset') return;
  }
  throw new Error(`refusing upgcmd ${args.join(' ')}: not on the read-only allow list`);
}

/**
 * Runs upgcmd with a timeout. The tool exits 0 even when it prints [ERROR],
 * and a failed command usually leaves the bootloader's USB session hung, so
 * any error line is fatal and says so.
 */
function upg(args, { timeout = 30_000, errorsExpected = false } = {}) {
  allow(args);
  const r = spawnSync(UPGCMD, args, { encoding: 'utf8', timeout });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.error?.code === 'ETIMEDOUT') fail(`upgcmd ${args[0]} timed out after ${timeout / 1000}s. Unplug and replug the dock.`);
  if (r.error) fail(`could not run ${UPGCMD}: ${r.error.message}`);
  if (/\[ERROR/.test(out) && !errorsExpected) fail(`upgcmd ${args.join(' ')} reported an error. Unplug and replug the dock.\n${out.trim()}`);
  return out;
}

// Enumeration only. Opening the dock to check would cost a close(), which
// sends CLE/HAN and blanks the panel.
function mode() {
  if (HID.devices().some(x => x.vendorId === UPGRADE_VID)) return 'upgrade';
  return StreamDock.list().length ? 'normal' : 'none';
}

async function waitFor(want, seconds) {
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    if (mode() === want) return i + 1;
  }
  return 0;
}

async function enterUpgrade() {
  const now = mode();
  if (now === 'upgrade') return console.log('dock already in upgrade mode');
  if (now !== 'normal') fail('no Stream Dock found. Plug it in, and quit VSD Craft and dockd.');
  const dock = StreamDock.open();
  dock.on('disconnect', () => {});  // the reboot is expected
  dock.sendRaw(APPNEW);
  const s = await waitFor('upgrade', 10);
  if (!s) fail('dock did not come back in upgrade mode within 10s. Replug it to recover.');
  console.log(`upgrade mode after ${s}s`);
}

function initFlash() {
  upg(['shcmd', 'spinor init 0']);
  // shcmd never reports shell failures, so confirm through the device log.
  // The log is cleared on read.
  const log = upg(['log']);
  if (!log.includes('probe spinor flash success')) fail(`spinor init did not probe the flash. Device log:\n${log.trim()}`);
}

function readFlash(label) {
  const dir = mkdtempSync(join(tmpdir(), 'm18-'));
  const chunkFile = join(dir, 'chunk.bin');
  const image = Buffer.alloc(FLASH_SIZE);
  const t0 = Date.now();
  try {
    for (let off = 0; off < FLASH_SIZE; off += CHUNK) {
      // A shell failure is silent, so without the sentinel a failed read would
      // hand back the previous chunk as if it were this one.
      upg(['fill', hex(RAM), hex(CHUNK), hex(SENTINEL)]);
      upg(['shcmd', `spinor read ${hex(RAM)} ${hex(off)} ${hex(CHUNK)}`]);
      upg(['read', hex(RAM), hex(CHUNK), chunkFile], { timeout: 60_000 });
      const chunk = readFileSync(chunkFile);
      if (chunk.length !== CHUNK) fail(`short read at ${hex(off)}: ${chunk.length} bytes`);
      if (chunk.every(b => b === SENTINEL)) fail(`chunk at ${hex(off)} still holds the RAM sentinel: the flash read did not happen`);
      chunk.copy(image, off);
      process.stdout.write(`\r${label}: ${((off + CHUNK) / 1048576).toFixed(2)} / 16 MB`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(` (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return image;
}

/** Minimal flattened-device-tree walk, enough to read a FIT image's hash nodes. */
function fitNodes(itb) {
  const [magic, , offStruct, offStrings, , , , , sizeStrings] =
    Array.from({ length: 9 }, (_, i) => itb.readUInt32BE(i * 4));
  if (magic !== 0xd00dfeed) return null;
  const strings = itb.subarray(offStrings, offStrings + sizeStrings);
  const name = o => strings.toString('latin1', o, strings.indexOf(0, o));
  const nodes = {};
  const path = [];
  let p = offStruct;
  for (;;) {
    const tok = itb.readUInt32BE(p); p += 4;
    if (tok === 1) {
      const end = itb.indexOf(0, p);
      path.push(itb.toString('latin1', p, end));
      nodes[path.join('/')] ??= {};
      p = (end + 4) & ~3;
    } else if (tok === 2) {
      path.pop();
    } else if (tok === 3) {
      const len = itb.readUInt32BE(p);
      const nameOff = itb.readUInt32BE(p + 4);
      nodes[path.join('/')][name(nameOff)] = itb.subarray(p + 8, p + 8 + len);
      p = (p + 8 + len + 3) & ~3;
    } else if (tok === 9) {
      return { nodes, dataBase: (itb.readUInt32BE(4) + 3) & ~3 };
    }
  }
}

/** Checks the image against everything it can vouch for itself. */
function verify(image) {
  const problems = [];
  if (image.toString('latin1', 0, 4) !== 'AIC ') problems.push('spl does not start with the "AIC " boot header');
  if (image.subarray(0, 0x100000).equals(image.subarray(0x800000, 0x900000))) {
    problems.push('first 1 MB repeats at 8 MB: the flash is probably 8 MB and the dump is mirrored');
  }

  const [, osOff, osSize] = PARTS.find(p => p[0] === 'os');
  const fit = fitNodes(image.subarray(osOff, osOff + osSize));
  let version = null;
  if (!fit) {
    problems.push('os partition is not a FIT image');
  } else {
    for (const [path, props] of Object.entries(fit.nodes)) {
      if (!props['data-size']) continue;
      const size = props['data-size'].readUInt32BE(0);
      const off = props['data-offset'] ? props['data-offset'].readUInt32BE(0) : 0;
      const seg = image.subarray(osOff + fit.dataBase + off, osOff + fit.dataBase + off + size);
      const wantCrc = fit.nodes[`${path}/hash-1`]?.value?.readUInt32BE(0);
      const wantMd5 = fit.nodes[`${path}/hash-2`]?.value?.toString('hex');
      const crcOk = wantCrc === undefined || crc32(seg) === wantCrc;
      const md5Ok = wantMd5 === undefined || createHash('md5').update(seg).digest('hex') === wantMd5;
      console.log(`  os ${path.split('/').pop()}: ${hex(size)} bytes, crc32 ${crcOk ? 'ok' : 'BAD'}, md5 ${md5Ok ? 'ok' : 'BAD'}`);
      if (!crcOk || !md5Ok) problems.push(`os ${path} fails its embedded checksum`);
      version ??= seg.toString('latin1').match(/V3\.[A-Z0-9_]+\.\d+\.\d+/)?.[0] ?? null;
    }
  }
  return { problems, version };
}

async function main() {
  if (!existsSync(UPGCMD)) fail(`upgcmd not found at ${UPGCMD}. Install VSD Craft, or pass --upgcmd=<path>.`);
  if (existsSync(OUT)) fail(`${OUT} already exists. Refusing to overwrite a backup.`);

  await enterUpgrade();
  initFlash();

  const image = readFlash('pass 1');
  if (has('twice')) {
    const again = readFlash('pass 2');
    if (!again.equals(image)) fail('the two passes differ. The flash reads are not stable; do not trust this dump.');
    console.log('pass 1 and pass 2 are identical');
  }

  writeFileSync(OUT, image);
  console.log(`wrote ${OUT}`);
  console.log(`md5 ${createHash('md5').update(image).digest('hex')}`);

  console.log('verifying:');
  const { problems, version } = verify(image);
  if (version) console.log(`  firmware version ${version}`);

  if (!has('keep-upgrade')) {
    // The device reboots before it can acknowledge, so upgcmd always reports a
    // USB error here. Whether the reset worked is judged by re-enumeration.
    upg(['shcmd', 'reset'], { errorsExpected: true });
    const s = await waitFor('normal', 10);
    console.log(s ? `dock back to normal after ${s}s` : 'dock did not come back by itself. Unplug and replug it.');
  }

  if (problems.length) fail(problems.join('\n      '));
  console.log('\nBackup looks good. Keep a copy somewhere safe, and do not share it.');
}

main().catch(err => fail(err.message));
