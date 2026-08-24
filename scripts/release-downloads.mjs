#!/usr/bin/env node
// Append a Downloads section to RELEASE_NOTES.md, listing the staged release
// assets under friendly labels: Desktop App first, then CLI App, then the
// verification files.
//
// Usage: node scripts/release-downloads.mjs <tag> [dist-dir]
//   tag       release tag, e.g. v0.2.1 (falls back to $GITHUB_REF_NAME)
//   dist-dir  directory of staged assets (default: dist)
//   $GITHUB_REPOSITORY  owner/repo for the download URLs (default: lorem-dev/skillkeeper)
//
// Two invariants this script is built around:
//
//  1. **It never renames anything.** Asset file names are the download contract:
//     scripts/install.sh and scripts/install.ps1 construct
//     `releases/<tag>/download/skillkeeper-cli-<target>.(tar.gz|zip)` from a
//     hardcoded pattern, without reading the release body or listing assets. This
//     script only *reads* the staged names and writes links to them, so the
//     one-line installers cannot be affected by anything here.
//
//  2. **It never silently drops an asset.** Names come from the Tauri bundler and
//     can change between versions. Anything this script cannot classify still
//     appears, under "Other", labelled with its raw file name. A release listing
//     that quietly omitted a platform would be worse than an ugly label.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env['GITHUB_REPOSITORY'] ?? 'lorem-dev/skillkeeper';

const rawTag = process.argv[2] ?? process.env['GITHUB_REF_NAME'];
if (!rawTag) {
  console.error('release-downloads: no tag given (arg or $GITHUB_REF_NAME)');
  process.exit(1);
}
const distArg = process.argv[3] ?? 'dist';
// Accept an absolute path as-is; resolve a relative one against the repo root so
// the default `dist` works regardless of the caller's cwd.
const distDir = isAbsolute(distArg) ? distArg : join(ROOT, distArg);
if (!existsSync(distDir)) {
  console.error(`release-downloads: no such directory: ${distDir}`);
  process.exit(1);
}

const url = (name) =>
  `https://github.com/${REPO}/releases/download/${encodeURIComponent(rawTag)}/${encodeURIComponent(name)}`;

/** Rust target triple -> human platform, for the CLI archives. */
const CLI_TARGETS = {
  'aarch64-apple-darwin': { os: 'macOS', arch: 'Apple Silicon', rank: 1 },
  'x86_64-apple-darwin': { os: 'macOS', arch: 'Intel', rank: 2 },
  'x86_64-pc-windows-msvc': { os: 'Windows', arch: 'x64', rank: 3 },
  'aarch64-pc-windows-msvc': { os: 'Windows', arch: 'arm64', rank: 4 },
  'x86_64-unknown-linux-gnu': { os: 'Linux', arch: 'x64', rank: 5 },
  'aarch64-unknown-linux-gnu': { os: 'Linux', arch: 'arm64', rank: 6 },
};

/** Desktop bundle extension -> the format shown in the label. */
const DESKTOP_FORMATS = [
  { test: /\.dmg$/i, os: 'macOS', format: 'dmg' },
  { test: /\.msi$/i, os: 'Windows', format: 'msi' },
  { test: /-setup\.exe$/i, os: 'Windows', format: 'exe setup' },
  { test: /\.exe$/i, os: 'Windows', format: 'exe' },
  { test: /\.msix$/i, os: 'Windows', format: 'msix' },
  { test: /\.AppImage$/i, os: 'Linux', format: 'AppImage' },
  { test: /\.deb$/i, os: 'Linux', format: 'deb' },
  { test: /\.rpm$/i, os: 'Linux', format: 'rpm' },
];

/** Order the platforms appear in, per section. */
const OS_RANK = { macOS: 1, Windows: 2, Linux: 3 };

/** Architecture guessed from a bundler file name; null when it says nothing. */
function desktopArch(name, os) {
  if (/aarch64|arm64/i.test(name)) return os === 'macOS' ? 'Apple Silicon' : 'arm64';
  if (/x64|amd64|x86_64/i.test(name)) return os === 'macOS' ? 'Intel' : 'x64';
  return null;
}

const desktop = [];
const cli = [];
const verification = [];
const other = [];

for (const name of readdirSync(distDir).sort()) {
  if (name === 'checksums.txt' || name === 'checksums.txt.asc') {
    verification.push({ name, label: name });
    continue;
  }

  // The mcp.yml JSON Schema. Labelled rather than left to "Other" because it
  // is something a reader goes looking for, not a build by-product -- an
  // mcp.yml points its editor at this exact asset.
  if (name === 'mcp.schema.json') {
    other.push({ name, label: 'JSON Schema for mcp.yml' });
    continue;
  }

  const cliMatch = /^skillkeeper-cli-(.+?)\.(tar\.gz|zip)$/.exec(name);
  if (cliMatch) {
    const triple = cliMatch[1];
    const known = CLI_TARGETS[triple];
    if (known) {
      cli.push({
        name,
        label: `CLI ${known.os} ${known.arch}`,
        rank: known.rank,
      });
    } else {
      // An unrecognized triple is still a real download; show the triple itself.
      cli.push({ name, label: `CLI ${triple}`, rank: 99 });
    }
    continue;
  }

  const bundle = DESKTOP_FORMATS.find((f) => f.test.test(name));
  if (bundle) {
    const arch = desktopArch(name, bundle.os);
    const label = arch ? `Desktop ${bundle.os} ${arch} (${bundle.format})` : `Desktop ${bundle.os} (${bundle.format})`;
    // Within an OS: the architecture most readers are on first, then the
    // other, then any bundle whose name states none. That is Apple Silicon on
    // macOS and x64 on Windows and Linux -- a single "arm64 first" rule was
    // right only while macOS was the sole dual-arch platform.
    const common = bundle.os === 'macOS' ? 'Apple Silicon' : 'x64';
    const archRank = arch === null ? 3 : arch === common ? 1 : 2;
    desktop.push({ name, label, rank: (OS_RANK[bundle.os] ?? 9) * 10 + archRank });
    continue;
  }

  other.push({ name, label: name });
}

const bullets = (entries) => entries.map((e) => `- [${e.label}](${url(e.name)})`).join('\n');
const bySortKey = (a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.label.localeCompare(b.label);

const sections = [];

// Desktop first: it is what most people arriving at a release page want.
if (desktop.length > 0) {
  sections.push(`### Desktop App\n\n${bullets(desktop.sort(bySortKey))}`);
}

if (cli.length > 0) {
  sections.push(
    `### CLI App\n\n${bullets(cli.sort(bySortKey))}\n\n` +
      'Or install it in one line, no download needed:\n\n' +
      '```bash\n' +
      `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sh\n` +
      '```\n\n' +
      '```powershell\n' +
      `irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex\n` +
      '```',
  );
}

if (other.length > 0) {
  sections.push(`### Other\n\n${bullets(other)}`);
}

if (verification.length > 0) {
  sections.push(
    `### Verification\n\n${bullets(verification)}\n\n` +
      'SHA-256 sums for every asset above. `checksums.txt.asc` is the detached ' +
      'GPG signature over `checksums.txt`, present when the release was signed.',
  );
}

if (sections.length === 0) {
  console.error(`release-downloads: no assets found in ${distDir}`);
  process.exit(1);
}

const notesPath = join(ROOT, 'RELEASE_NOTES.md');
const existing = existsSync(notesPath) ? readFileSync(notesPath, 'utf8').trimEnd() : '';
const downloads = `## Downloads\n\n${sections.join('\n\n')}`;
const body = existing.length > 0 ? `${existing}\n\n${downloads}\n` : `${downloads}\n`;

writeFileSync(notesPath, body);
console.log(downloads);
