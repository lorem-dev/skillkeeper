// Regenerate every platform icon binary from the icon PNGs. Cross-platform:
// pure JS, no native tools (no iconutil/sips/ImageMagick required).
//
// Source of record is icon.icon (Apple Icon Composer project). Export it from
// Icon Composer as two full-bleed 1024x1024 PNGs and drop them next to this
// file, then run:
//
//     pnpm --filter @skillkeeper/desktop run generate-icons
//
//   icon-default.png  light appearance (the app's default icon)
//   icon-dark.png     dark appearance (used at runtime under a dark OS theme)
//
// Icon Composer exports 16-bit PNGs; the script rewrites any 16-bit source to
// 8-bit in place (visually lossless, ~4x smaller) before deriving anything.
//
// Icon Composer exports a full-bleed square (rounded body touching the canvas
// edges, as iOS expects). Desktop icon slots -- the macOS dock especially --
// expect the artwork inset within the canvas (Apple's macOS grid: an 824x824
// body in a 1024 canvas), or the icon looks oversized next to its neighbours.
// So each source is inset into a padded master, and every platform output is
// derived from those.
//
// The `dev`, `build`, `package` and `package:dir` scripts run this first, so
// the outputs below are always present and fresh. Generation is skipped when
// the sources are unchanged (a sha256 is cached in .icon-cache.json) and every
// output already exists. Pass --force to regenerate regardless.
//
// Outputs (all git-ignored, see build/.gitignore):
//   icon.app.png       padded light master; Linux icon (build.linux.icon) and
//                      the runtime light icon (imported by src/main/index.ts)
//   icon-dark.app.png  padded dark master; the runtime dark icon
//   icon.icns          macOS   (build.mac.icon), from the light master
//   icon.ico           Windows (build.win.icon), from the light master
//   appx/*.png         Windows Store Visual Assets, from the light master
//
// The only committed rasters are icon-default.png and icon-dark.png -- the
// pristine full-bleed sources.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import png2icons from 'png2icons';
import { Jimp } from 'jimp';

const BUILD_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_LIGHT = join(BUILD_DIR, 'icon-default.png');
const SRC_DARK = join(BUILD_DIR, 'icon-dark.png');
const CACHE = join(BUILD_DIR, '.icon-cache.json');

// Apple's macOS icon grid: an 824x824 body centered in a 1024 canvas.
const CANVAS = 1024;
const CONTENT = 824;

// Square Windows Store assets: [pixel size, filename].
const APPX_SQUARES = [
  [50, 'StoreLogo.png'],
  [44, 'Square44x44Logo.png'],
  [71, 'Square71x71Logo.png'],
  [150, 'Square150x150Logo.png'],
  [310, 'Square310x310Logo.png'],
];
const APPX_WIDE = 'Wide310x150Logo.png';

// Every file this script produces, relative to BUILD_DIR.
const OUTPUT_FILES = [
  'icon.app.png',
  'icon-dark.app.png',
  'icon.icns',
  'icon.ico',
  ...APPX_SQUARES.map(([, name]) => `appx/${name}`),
  `appx/${APPX_WIDE}`,
];

// PNG bit depth lives in the IHDR chunk at byte offset 24 (8-byte signature +
// 4 length + 4 "IHDR" + 4 width + 4 height). Returns 0 for a non-PNG.
function pngBitDepth(buf) {
  const isPng = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  return isPng ? buf[24] : 0;
}

// Icon Composer exports 16-bit PNGs (~1.5 MB). Collapse a source to 8-bit in
// place (visually lossless, ~4x smaller) so the committed sources stay small
// and every downstream output derives from 8-bit data. No-op if already 8-bit.
async function ensure8Bit(src) {
  if (pngBitDepth(readFileSync(src)) !== 16) return false;
  // jimp works in 8-bit RGBA internally, so re-encoding downconverts.
  const image = await Jimp.read(src);
  writeFileSync(src, await image.getBuffer('image/png'));
  return true;
}

// A fresh copy of a full-bleed source inset into the macOS icon grid: any
// transparent border is trimmed, the body scaled to CONTENT, and centered on a
// transparent CANVAS square.
async function paddedMaster(src) {
  const icon = await Jimp.read(src);
  if (typeof icon.autocrop === 'function') icon.autocrop();
  icon.resize({ w: CONTENT, h: CONTENT });
  const canvas = new Jimp({ width: CANVAS, height: CANVAS, color: 0x00000000 });
  const offset = Math.round((CANVAS - CONTENT) / 2);
  canvas.composite(icon, offset, offset);
  return canvas;
}

async function squareAt(size) {
  const image = await paddedMaster(SRC_LIGHT);
  image.resize({ w: size, h: size });
  return image.getBuffer('image/png');
}

function isUpToDate(hash) {
  if (!existsSync(CACHE)) return false;
  let cached;
  try {
    cached = JSON.parse(readFileSync(CACHE, 'utf8'));
  } catch {
    return false;
  }
  if (cached.hash !== hash) return false;
  // A matching hash is not enough: an output may have been deleted (e.g. a
  // fresh checkout, since the outputs are git-ignored).
  return OUTPUT_FILES.every((rel) => existsSync(join(BUILD_DIR, rel)));
}

export async function generateIcons({ force = false } = {}) {
  for (const src of [SRC_LIGHT, SRC_DARK]) {
    if (!existsSync(src)) {
      throw new Error(`${src} not found -- export it from icon.icon in Icon Composer`);
    }
  }

  // Downconvert any 16-bit source to 8-bit first, so the hash and every output
  // reflect the optimized bytes. A conversion changes the source, hence the
  // hash, which forces a regenerate below.
  const converted = [];
  for (const src of [SRC_LIGHT, SRC_DARK]) {
    if (await ensure8Bit(src)) converted.push(basename(src));
  }

  const hash = createHash('sha256')
    .update(readFileSync(SRC_LIGHT))
    .update(readFileSync(SRC_DARK))
    .digest('hex');

  if (!force && isUpToDate(hash)) {
    return { skipped: true, hash, converted };
  }

  // Padded masters. The light master feeds every packaged binary; both masters
  // are bundled for the runtime theme switch.
  const light = await (await paddedMaster(SRC_LIGHT)).getBuffer('image/png');
  const dark = await (await paddedMaster(SRC_DARK)).getBuffer('image/png');
  writeFileSync(join(BUILD_DIR, 'icon.app.png'), light);
  writeFileSync(join(BUILD_DIR, 'icon-dark.app.png'), dark);

  // macOS .icns and Windows .ico -- png2icons resizes internally from the
  // light master and packs every required representation.
  const icns = png2icons.createICNS(light, png2icons.BICUBIC, 0);
  const ico = png2icons.createICO(light, png2icons.BICUBIC, 0, true, false);
  if (!icns || !ico) throw new Error('png2icons failed to encode the icon');
  writeFileSync(join(BUILD_DIR, 'icon.icns'), icns);
  writeFileSync(join(BUILD_DIR, 'icon.ico'), ico);

  // Windows Store Visual Assets. The AppxManifest is generated from the `appx`
  // config block by electron-builder; only the images live here.
  const appxDir = join(BUILD_DIR, 'appx');
  mkdirSync(appxDir, { recursive: true });
  for (const [size, name] of APPX_SQUARES) {
    writeFileSync(join(appxDir, name), await squareAt(size));
  }
  // Wide tile: the padded icon centered on a transparent 310x150 canvas.
  const wideIcon = await paddedMaster(SRC_LIGHT);
  wideIcon.resize({ w: 150, h: 150 });
  const wide = new Jimp({ width: 310, height: 150, color: 0x00000000 });
  wide.composite(wideIcon, 80, 0);
  writeFileSync(join(appxDir, APPX_WIDE), await wide.getBuffer('image/png'));

  writeFileSync(
    CACHE,
    `${JSON.stringify({ sources: ['icon-default.png', 'icon-dark.png'], hash, files: OUTPUT_FILES }, null, 2)}\n`,
  );

  return { skipped: false, hash, converted, icns: icns.length, ico: ico.length, appxAssets: APPX_SQUARES.length + 1 };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  generateIcons({ force: process.argv.includes('--force') })
    .then((r) => {
      if (r.converted.length) {
        console.log(`downconverted 16-bit -> 8-bit: ${r.converted.join(', ')}`);
      }
      if (r.skipped) {
        console.log(`icons up to date (${r.hash.slice(0, 12)}), skipping`);
      } else {
        console.log(
          `generated icon.app.png + icon-dark.app.png, icon.icns (${r.icns} B), icon.ico (${r.ico} B), ${r.appxAssets} appx assets`,
        );
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
