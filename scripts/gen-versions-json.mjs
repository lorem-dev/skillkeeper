#!/usr/bin/env node
// Generate the self-updater manifest (dist/versions.json) that the desktop
// app reads to decide whether a newer release exists and which asset to fetch.
//
// Usage: node scripts/gen-versions-json.mjs <tag> [dist-dir]
//   tag       the tag being published right now, e.g. v0.6.0 (with the leading
//             "v"; falls back to $GITHUB_REF_NAME is not required here since
//             the release workflow always passes it explicitly)
//   dist-dir  directory of staged release assets (default: dist)
//
// buildManifest() below is a pure function: given the changelog text, the set
// of tags GitHub still has releases for, the tag being published, and the
// staged asset list, it returns the manifest object. That makes it testable
// without `gh` or a checkout. Everything past the "CLI wrapper" comment below
// gathers those real inputs and writes dist/versions.json; it never runs
// during `import` (see the entry-point guard at the bottom), so importing
// buildManifest from a test has no side effects.
//
// Schema (kept in lockstep with crates/skillkeeper-core/src/app_update/manifest.rs):
//   { schema, generatedAt, versions: [ { version, prerelease, tag, notes?, assets? } ] }
// `assets` maps "<os>-<arch>" (Rust's std::env::consts::OS/ARCH spelling --
// "macos", NOT "darwin") to an array of { kind, name, sha256 }.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// -----------------------------------------------------------------------
// Changelog parsing -- same "## Version X" heading shape release-notes.mjs
// matches, generalized to discover every version rather than one already
// known. Deliberately does NOT match "## Development": unreleased notes must
// never reach a published manifest.
// -----------------------------------------------------------------------

const HEADING_RE = /^## Version (\S+)(?:\s.*)?$/;

/** Every `## Version X` section in `changes`, in document order (newest first). */
function parseChangelogSections(changes) {
  const lines = changes.split('\n');
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]);
    if (!match) continue;
    const version = match[1];

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('## ')) {
        end = j;
        break;
      }
    }

    const body = lines
      .slice(i + 1, end)
      .join('\n')
      .trim();
    sections.push({
      version,
      tag: `v${version}`,
      notes: body.length > 0 ? body : undefined,
    });
  }
  return sections;
}

/**
 * Strict whole-number parse: rejects empty or non-digit input, so a
 * malformed "## Version" heading fails loudly here rather than quietly
 * producing a NaN comparison in compareVersionsDesc, which sorts as neither
 * greater nor less than anything and would leave the manifest ordered by
 * accident instead of by version.
 */
function parseUint(segment, whole) {
  if (!/^[0-9]+$/.test(segment)) {
    throw new Error(`gen-versions-json: malformed version "${whole}": "${segment}" is not a whole number`);
  }
  return Number.parseInt(segment, 10);
}

/**
 * Parse "X.Y.Z" or "X.Y.Z-rc.N" into { major, minor, patch, rc }, matching
 * the grammar crates/skillkeeper-core/src/app_update/version.rs::Version
 * enforces (rc, when present, is always a whole number after "-rc.").
 */
function parseVersion(version) {
  const rcMatch = /^(.+)-rc\.([^.]+)$/.exec(version);
  const core = rcMatch ? rcMatch[1] : version;
  const rc = rcMatch ? parseUint(rcMatch[2], version) : undefined;

  const segments = core.split('.');
  if (segments.length !== 3) {
    throw new Error(`gen-versions-json: malformed version heading: "${version}"`);
  }
  const [major, minor, patch] = segments.map((s) => parseUint(s, version));
  return { major, minor, patch, rc };
}

/**
 * Descending comparator: newer versions first. Mirrors version.rs's `Ord`
 * for `Version`: the major/minor/patch triple decides first; within the same
 * triple, a final release (no `-rc.N`) sorts above every one of its own
 * candidates, and two candidates sort by their rc number NUMERICALLY -- not
 * by comparing "rc.9" and "rc.10" as strings, which would put rc.10 behind
 * rc.2 and rc.9 (CHANGES.md already carries adjacent two-digit RCs, so this
 * is not a hypothetical: it decides which entry keeps its `notes`).
 */
function compareVersionsDesc(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pb.major - pa.major;
  if (pa.minor !== pb.minor) return pb.minor - pa.minor;
  if (pa.patch !== pb.patch) return pb.patch - pa.patch;
  if (pa.rc === pb.rc) return 0;
  if (pa.rc === undefined) return -1;
  if (pb.rc === undefined) return 1;
  return pb.rc - pa.rc;
}

/** Only the ten most recent entries carry notes; only the newest carries assets. */
const MAX_VERSIONS = 100;
const MAX_NOTES = 10;

/**
 * Build the `versions.json` manifest object.
 *
 * @param {object} input
 * @param {string} input.changes - CHANGES.md contents.
 * @param {string[]} input.existingTags - tags (with leading "v") GitHub still
 *   has a release for. A tag missing here is dropped, so a deleted release
 *   stops being advertised.
 * @param {string} input.currentTag - the tag being published right now (with
 *   leading "v"). Always kept, even when absent from `existingTags`: the
 *   release for it does not exist on GitHub yet at the point this runs.
 * @param {{ key: string, kind: string, name: string, sha256: string }[]} input.assets
 *   - staged assets for `currentTag`, attached only to that entry. See the
 *   comment above the assignment below for why that is the correct entry,
 *   not merely a convenient one.
 * @param {string} input.generatedAt - stamped verbatim as `generatedAt`.
 * @returns {{ schema: number, generatedAt: string, versions: object[] }}
 * @throws {Error} when `currentTag` matches no section in `changes`: a tag
 *   was pushed without bump-version promoting Development, or the heading's
 *   version segment disagrees with the tag. Without this guard the staged
 *   assets are hashed and then silently discarded, and
 *   `crates/skillkeeper-core/src/app_update/decide.rs` is left with a
 *   manifest that never mentions this release at all -- attached to a
 *   published, un-recallable release, with no warning and exit 0. A manifest
 *   this script cannot build correctly must not be built at all.
 */
export function buildManifest({ changes, existingTags, currentTag, assets, generatedAt }) {
  const existing = new Set(existingTags);

  const assetsByKey = {};
  for (const asset of assets) {
    const list = assetsByKey[asset.key] ?? (assetsByKey[asset.key] = []);
    list.push({ kind: asset.kind, name: asset.name, sha256: asset.sha256 });
  }

  const kept = parseChangelogSections(changes)
    .filter((section) => section.tag === currentTag || existing.has(section.tag))
    .sort((a, b) => compareVersionsDesc(a.version, b.version))
    .slice(0, MAX_VERSIONS);

  // A tag published without a matching "## Version" heading -- bump-version
  // did not promote Development before tagging, or the heading's version
  // segment disagrees with the tag -- must not silently produce a manifest
  // that omits this release while still exiting 0. `kept` always keeps a
  // section whose tag equals currentTag (see the filter above), so its
  // absence here means no such section exists at all.
  if (!kept.some((section) => section.tag === currentTag)) {
    throw new Error(
      `gen-versions-json: currentTag "${currentTag}" matches no "## Version" section in ` +
        'CHANGES.md; refusing to publish a manifest that would silently drop this release',
    );
  }

  const versions = kept.map((section, index) => {
    const entry = {
      version: section.version,
      prerelease: section.version.includes('-'),
      tag: section.tag,
    };
    if (index < MAX_NOTES) entry.notes = section.notes;
    // decide() in decide.rs never simply picks the greatest version in the
    // whole manifest: `candidates` is filtered to versions above the running
    // one (`*v > current`) AND to the client's channel
    // (`accepts_prerelease || !v.is_prerelease()`) before `.first()` is
    // taken. Both filters are per-client, so the entry that filtering
    // resolves to is not "the newest entry overall" -- it is "the newest
    // entry the running client is willing to consider", which is exactly
    // the release being published right now in every case that release is
    // relevant to that client. A stable client publishing a v0.5.1 patch
    // while a v0.6.0-rc.1 candidate already exists filters the RC out of
    // its own candidate list, so its `first()` is v0.5.1 -- the assets
    // belong there, not on the RC. Attaching them to whichever entry is
    // merely the highest version number would give that stable client
    // nothing, and would hand an RC client a filename and hash pair built
    // for a different release entirely.
    if (section.tag === currentTag) entry.assets = assetsByKey;
    return entry;
  });

  return { schema: 1, generatedAt, versions };
}

// -----------------------------------------------------------------------
// CLI wrapper -- gathers the real inputs and writes dist/versions.json.
// Nothing below this point runs on `import`; see the entry-point guard.
// -----------------------------------------------------------------------

/** dmg/deb/appimage/nsis/msi file-name -> { key, kind }, or undefined when unrecognized. */
const BUNDLE_RULES = [
  { ext: /\.dmg$/i, kind: 'dmg', os: 'macos', tokens: { x64: 'x86_64', aarch64: 'aarch64' } },
  { ext: /-setup\.exe$/i, kind: 'nsis', os: 'windows', tokens: { x64: 'x86_64', arm64: 'aarch64' } },
  { ext: /\.msi$/i, kind: 'msi', os: 'windows', tokens: { x64: 'x86_64', arm64: 'aarch64' } },
  { ext: /\.appimage$/i, kind: 'appimage', os: 'linux', tokens: { amd64: 'x86_64', aarch64: 'aarch64' } },
  { ext: /\.deb$/i, kind: 'deb', os: 'linux', tokens: { amd64: 'x86_64', arm64: 'aarch64' } },
];

// Staged files that are never a desktop bundle: the JSON Schema for mcp.yml,
// the CLI archives, and the checksum files a later workflow step writes.
// These never trigger the "cannot classify" warning below.
const CLI_ARCHIVE_RE = /^skillkeeper-cli-.+\.(tar\.gz|zip)$/;
const NON_BUNDLE_NAMES = new Set(['mcp.schema.json', 'checksums.txt', 'checksums.txt.asc']);

// The Windows MSIX ("Package Windows MSIX (MakeAppx)" in release.yml) is
// staged unconditionally on every Windows leg, but
// platform.rs::preferred_kinds() never asks for a "msix" kind -- Windows
// only ever prefers nsis then msi, so an msix entry in the manifest would be
// dead weight the updater can never select. Decision: skip it explicitly, by
// name pattern, rather than let it fall through classifyBundle and warn --
// a warning on every single release trains people to stop reading warnings.
const MSIX_RE = /\.msix$/i;

/** Classify one staged file name into `{ key, kind }`, or null if it cannot be. */
export function classifyBundle(name) {
  const rule = BUNDLE_RULES.find((r) => r.ext.test(name));
  if (!rule) return null;
  const parts = new Set(name.split(/[^A-Za-z0-9]+/));
  for (const [token, arch] of Object.entries(rule.tokens)) {
    if (parts.has(token)) return { key: `${rule.os}-${arch}`, kind: rule.kind };
  }
  return null;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Staged bundles under `distDir`, as `{ key, kind, name, sha256 }`. */
export function scanAssets(distDir) {
  const assets = [];
  for (const name of readdirSync(distDir).sort()) {
    if (!statSync(join(distDir, name)).isFile()) continue;
    if (NON_BUNDLE_NAMES.has(name) || CLI_ARCHIVE_RE.test(name) || MSIX_RE.test(name)) continue;

    const classified = classifyBundle(name);
    if (classified === null) {
      console.error(
        `::warning::gen-versions-json: cannot classify staged file "${name}"; it will not appear in versions.json`,
      );
      continue;
    }
    assets.push({ key: classified.key, kind: classified.kind, name, sha256: sha256(join(distDir, name)) });
  }
  return assets;
}

/**
 * Tags GitHub still has a release for, or every tag already in CHANGES.md
 * when the lookup fails. A failed lookup must never be read as "every
 * release was deleted" -- that would empty the manifest and strand every
 * installed client, so failure keeps history rather than dropping it.
 */
export function listExistingTags(changes) {
  try {
    const raw = execFileSync('gh', ['release', 'list', '--limit', '200', '--json', 'tagName'], {
      encoding: 'utf8',
    });
    const releases = JSON.parse(raw);
    return releases.map((r) => r.tagName);
  } catch (error) {
    console.error(
      `::warning::gen-versions-json: "gh release list" failed (${error.message}); ` +
        'keeping every version already in CHANGES.md instead of dropping them.',
    );
    return parseChangelogSections(changes).map((s) => s.tag);
  }
}

/**
 * Gather the real inputs (CLI args, env, filesystem, `gh`) and write
 * `dist/versions.json`. Takes its inputs as parameters, each defaulting to
 * the real process/filesystem, so a test can drive the whole composition --
 * `scanAssets` + the current tag + `buildManifest` -- against a synthetic
 * directory without touching the real `process.argv` or `CHANGES.md`.
 *
 * Throws instead of calling `process.exit` directly, so a caller (a test, or
 * the CLI entry-point guard below) decides what to do with the failure.
 *
 * @param {object} [input]
 * @param {string[]} [input.argv] - defaults to `process.argv`; `argv[2]` is
 *   the tag, `argv[3]` the dist directory.
 * @param {NodeJS.ProcessEnv} [input.env] - defaults to `process.env`; used
 *   for `GITHUB_REF_NAME` when `argv[2]` is absent.
 * @param {string} [input.root] - repository root, for resolving a relative
 *   dist directory and locating `CHANGES.md`. Defaults to this script's
 *   real repository root.
 * @param {() => string} [input.now] - returns the manifest's `generatedAt`.
 *   Defaults to the current time.
 * @returns {{ schema: number, generatedAt: string, versions: object[] }} the
 *   manifest that was written.
 */
export function main({
  argv = process.argv,
  env = process.env,
  root = ROOT,
  now = () => new Date().toISOString(),
} = {}) {
  const currentTag = argv[2] ?? env['GITHUB_REF_NAME'];
  if (!currentTag) {
    throw new Error('gen-versions-json: no tag given (arg or $GITHUB_REF_NAME)');
  }
  const distArg = argv[3] ?? 'dist';
  const distDir = isAbsolute(distArg) ? distArg : join(root, distArg);
  if (!existsSync(distDir)) {
    throw new Error(`gen-versions-json: no such directory: ${distDir}`);
  }

  const changes = readFileSync(join(root, 'CHANGES.md'), 'utf8');
  const existingTags = listExistingTags(changes);
  const assets = scanAssets(distDir);

  const manifest = buildManifest({
    changes,
    existingTags,
    currentTag,
    assets,
    generatedAt: now(),
  });

  const outPath = join(distDir, 'versions.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`gen-versions-json: wrote ${manifest.versions.length} version(s) to ${outPath}`);
  return manifest;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
