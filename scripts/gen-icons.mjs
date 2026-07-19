// Regenerate the desktop app's icon set from the sources in `assets/icons/`.
//
// Single source of truth: `assets/icons/icon-default.png` (light) and
// `icon-dark.png` (dark), plus the renderer glyph SVGs for the macOS menu.
// This script insets each full-bleed source into the macOS icon grid (an
// 824x824 body in a 1024 canvas -- otherwise the dock icon looks oversized
// next to its neighbours), then derives every platform binary INTO
// `apps/desktop/src-tauri/icons/`:
//
//   32x32 / 64x64 / 128x128 / 128x128@2x / icon.png / icon.icns / icon.ico
//   Square*Logo.png / StoreLogo.png / Wide310x150Logo.png   (via `tauri icon`)
//   icon-light-256.png / icon-dark-256.png                  (runtime theme swap)
//   menu-icons/<glyph>Template(.png|@2x.png)                (macOS menu glyphs)
//
// The generated files under src-tauri/icons/ are GIT-IGNORED and produced at
// build time: the desktop crate's `build.rs` runs this script when the set is
// missing (fresh clone / `git clean`), and CI regenerates it explicitly before
// `cargo`/`tauri build`. The Rust `include_bytes!` in app/menu.rs and app/theme.rs,
// the tauri.conf `bundle.icon`/`resources` globs, and `generate_context!` all
// read these at `cargo build` time, so they must exist before compilation.
//
// Re-run manually whenever the sources in assets/icons/ change:
//
//     pnpm run icons        (or: node scripts/gen-icons.mjs)
//
// Cross-platform: the main set uses pure-JS jimp; the menu glyphs use
// @resvg/resvg-js (prebuilt for every platform). The `tauri icon` step needs
// the desktop `@tauri-apps/cli`, so `pnpm install` must have run.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets', 'icons');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const ICONS = join(DESKTOP, 'src-tauri', 'icons');
const GLYPH_SVGS = join(DESKTOP, 'src', 'renderer', 'shared', 'ui', 'Icon', 'assets');

const SRC_LIGHT = join(ASSETS, 'icon-default.png');
const SRC_DARK = join(ASSETS, 'icon-dark.png');

// Apple's macOS icon grid: an 824x824 body centered in a 1024 canvas.
const CANVAS = 1024;
const CONTENT = 824;

const MENU_GLYPHS = [
  'projects',
  'repositories',
  'skills',
  'mcp',
  'settings',
  'info',
  // Standard Edit menu items (custom, translated -> need their own glyphs).
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'select-all',
];

// A full-bleed source inset into the macOS icon grid: trim any transparent
// border, scale the body to CONTENT, and center it on a transparent canvas.
async function paddedMaster(src) {
  const icon = await Jimp.read(src);
  if (typeof icon.autocrop === 'function') icon.autocrop();
  icon.resize({ w: CONTENT, h: CONTENT });
  const canvas = new Jimp({ width: CANVAS, height: CANVAS, color: 0x00000000 });
  const offset = Math.round((CANVAS - CONTENT) / 2);
  canvas.composite(icon, offset, offset);
  return canvas;
}

async function pngAt(master, size) {
  const image = master.clone();
  image.resize({ w: size, h: size });
  return image.getBuffer('image/png');
}

// Template glyphs are tinted by the system from their alpha; force opaque black
// so the shape (not source color) drives the mask.
function blacken(svg) {
  return svg
    .replace(/currentColor/g, '#000000')
    .replace(/fill="(?!none)[^"]*"/g, 'fill="#000000"')
    .replace(/stroke="(?!none)[^"]*"/g, 'stroke="#000000"');
}

async function generateMenuIcons() {
  // @resvg/resvg-js ships prebuilt binaries for every CI platform, so the menu
  // glyphs regenerate everywhere -- required now the icon set is git-ignored and
  // produced at build time rather than committed.
  const { Resvg } = await import('@resvg/resvg-js');
  const out = join(ICONS, 'menu-icons');
  mkdirSync(out, { recursive: true });
  const render = (svg, size) =>
    new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  for (const glyph of MENU_GLYPHS) {
    const svg = blacken(readFileSync(join(GLYPH_SVGS, `${glyph}.svg`), 'utf8'));
    writeFileSync(join(out, `${glyph}Template.png`), render(svg, 16));
    writeFileSync(join(out, `${glyph}Template@2x.png`), render(svg, 32));
  }
  console.log(`menu glyphs: ${MENU_GLYPHS.length} rendered (Template + @2x)`);
}

async function main() {
  mkdirSync(ICONS, { recursive: true });

  // Padded masters (the #16 dock-size fix): the light master feeds every
  // packaged binary; both are kept at 256 for the runtime light/dark swap.
  const light = await paddedMaster(SRC_LIGHT);
  const dark = await paddedMaster(SRC_DARK);

  // Feed the PADDED light master to `tauri icon`, which emits the full desktop
  // set (icns/ico/pngs/Store tiles) into src-tauri/icons/. A padded input is
  // what keeps the dock icon sized like its neighbours.
  const tmp = join(ICONS, '.master.png');
  writeFileSync(tmp, await light.getBuffer('image/png'));
  execFileSync('pnpm', ['--filter', '@skillkeeper/desktop', 'exec', 'tauri', 'icon', tmp], {
    stdio: 'inherit',
    // On Windows `pnpm` is a `.cmd` shim; execFile needs a shell to resolve it.
    shell: process.platform === 'win32',
  });
  rmSync(tmp, { force: true });
  // `tauri icon` also drops mobile sets we do not ship.
  rmSync(join(ICONS, 'android'), { recursive: true, force: true });
  rmSync(join(ICONS, 'ios'), { recursive: true, force: true });

  // Runtime theme-swap window icons (embedded by app/theme.rs).
  writeFileSync(join(ICONS, 'icon-light-256.png'), await pngAt(light, 256));
  writeFileSync(join(ICONS, 'icon-dark-256.png'), await pngAt(dark, 256));
  console.log('generated src-tauri/icons/ from assets/icons/ (padded masters)');

  // Documentation site logo: the Material for MkDocs header logo + favicon, with
  // a dark-mode swap (docs/assets/extra.css). Unlike the src-tauri/ set these
  // are COMMITTED (not git-ignored) so CI does not need to rebuild them; keep
  // them in sync with the app icon sources here. Copied verbatim (full-bleed,
  // no macOS padding) since the docs chrome scales them itself.
  const docsAssets = join(ROOT, 'docs', 'assets');
  mkdirSync(docsAssets, { recursive: true });
  copyFileSync(SRC_LIGHT, join(docsAssets, 'logo.png'));
  copyFileSync(SRC_DARK, join(docsAssets, 'logo-dark.png'));
  console.log('synced docs/assets/ logo.png + logo-dark.png from assets/icons/');

  await generateMenuIcons();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
