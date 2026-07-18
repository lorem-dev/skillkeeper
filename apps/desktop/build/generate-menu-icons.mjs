// Rasterize the tray/menu glyph SVGs into macOS template PNGs.
//
// macOS-only: menu icons are a macOS affordance (NSMenuItem.image with a
// template image, tinted by the system for the current appearance and menu
// state). This script no-ops on every other platform.
//
// Sources are the same stroke-based glyph SVGs the renderer's <Icon> uses
// (fill="none" stroke="currentColor"). A template image is a plain alpha
// mask -- macOS derives color from the shape's alpha, not from any RGB in
// the file -- so `currentColor` is forced to opaque black before rasterizing
// (fill stays "none"; only the stroke carries the artwork).
//
// The `dev`, `build`, `package` and `package:dir` scripts run this alongside
// generate-icons; it is always safe to invoke (see the darwin guard above).
// Generation is skipped when the sources are unchanged (a sha256 is cached
// in .menu-icon-cache.json) and every output already exists. Pass --force to
// regenerate regardless.
//
// Outputs (all git-ignored, see build/.gitignore):
//   menu-icons/<glyph>Template.png      16x16, 1x
//   menu-icons/<glyph>Template@2x.png   32x32, 2x

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const BUILD_DIR = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(BUILD_DIR, '..', 'src', 'renderer', 'shared', 'ui', 'Icon', 'assets');
const OUT = join(BUILD_DIR, 'menu-icons');
const CACHE = join(BUILD_DIR, '.menu-icon-cache.json');

const GLYPHS = ['projects', 'repositories', 'skills', 'mcp', 'settings', 'info'];

// Every file this script produces, relative to BUILD_DIR.
const OUTPUT_FILES = GLYPHS.flatMap((glyph) => [
  `menu-icons/${glyph}Template.png`,
  `menu-icons/${glyph}Template@2x.png`,
]);

// Template images are tinted by the system from their alpha; force opaque
// black so shape (not source color) drives the mask.
function blacken(svg) {
  return svg
    .replace(/currentColor/g, '#000000')
    .replace(/fill="(?!none)[^"]*"/g, 'fill="#000000"')
    .replace(/stroke="(?!none)[^"]*"/g, 'stroke="#000000"');
}

function render(Resvg, svg, size) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return resvg.render().asPng();
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

export async function generateMenuIcons({ force = false } = {}) {
  if (process.platform !== 'darwin') {
    // Menu icons are a macOS-only affordance; no-op elsewhere. Bail out
    // before ever importing @resvg/resvg-js, whose native binding is not
    // guaranteed to have a prebuilt for every non-macOS CI platform.
    return { skipped: true, reason: 'not-darwin' };
  }

  const sources = GLYPHS.map((glyph) => join(ASSETS, `${glyph}.svg`));
  for (const src of sources) {
    if (!existsSync(src)) throw new Error(`missing glyph SVG: ${src}`);
  }

  const hasher = createHash('sha256');
  for (const src of sources) hasher.update(readFileSync(src));
  const hash = hasher.digest('hex');

  if (!force && isUpToDate(hash)) {
    return { skipped: true, reason: 'up-to-date', hash };
  }

  const { Resvg } = await import('@resvg/resvg-js');

  mkdirSync(OUT, { recursive: true });

  for (const glyph of GLYPHS) {
    const svg = blacken(readFileSync(join(ASSETS, `${glyph}.svg`), 'utf8'));
    writeFileSync(join(OUT, `${glyph}Template.png`), render(Resvg, svg, 16));
    writeFileSync(join(OUT, `${glyph}Template@2x.png`), render(Resvg, svg, 32));
  }

  writeFileSync(CACHE, `${JSON.stringify({ sources: GLYPHS.map((g) => `${g}.svg`), hash, files: OUTPUT_FILES }, null, 2)}\n`);

  return { skipped: false, hash, glyphs: GLYPHS.length };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  try {
    const r = await generateMenuIcons({ force: process.argv.includes('--force') });
    if (r.skipped && r.reason === 'not-darwin') {
      console.log('skipping menu icon generation: not macOS');
    } else if (r.skipped) {
      console.log(`menu icons up to date (${r.hash.slice(0, 12)}), skipping`);
    } else {
      console.log(`generated ${r.glyphs} menu glyph icons (Template.png + @2x) into build/menu-icons/`);
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
