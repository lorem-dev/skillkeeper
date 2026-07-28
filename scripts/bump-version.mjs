#!/usr/bin/env node
// Bump the monorepo version and promote the CHANGES.md changelog.
// Usage: node scripts/bump-version.mjs <version>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// JSON manifests carrying a "version" field (root, the remaining i18n package,
// the desktop app, and the Tauri bundle config). The Rust domain/CLI now live in
// crates/ (bumped via Cargo.toml below); the old TS domain/CLI packages are gone.
const PACKAGE_FILES = [
  "package.json",
  "packages/i18n/package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) fail("usage: node scripts/bump-version.mjs <version>");
if (!SEMVER.test(version)) fail(`invalid semver: ${version}`);

// 1. Update every package.json version, preserving the existing 2-space format.
for (const rel of PACKAGE_FILES) {
  const path = join(root, rel);
  const text = readFileSync(path, "utf8");
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (next === text) fail(`no version field updated in ${rel}`);
  writeFileSync(path, next);
  console.log(`updated ${rel} -> ${version}`);
}

// 1b. Update the Rust workspace version (all crates inherit it via
//     `version.workspace = true`), so the Cargo/tauri versions the release
//     guard (check-version.mjs) asserts stay in sync with the tag.
{
  const path = join(root, "Cargo.toml");
  const text = readFileSync(path, "utf8");
  const next = text.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${version}"`);
  if (next === text) fail("no version field updated in Cargo.toml");
  writeFileSync(path, next);
  console.log(`updated Cargo.toml -> ${version}`);
}

// 1c. Update Cargo.lock's entries for the workspace members. The lock records
//      each member's version alongside the registry crates, so leaving it alone
//      makes it drift a release behind: cargo rewrites it on the next build,
//      which either shows up as a dirty tree after tagging or, with `--locked`,
//      fails the build outright. Only the members' own `version` lines are
//      touched -- dependency resolution is not, so this needs no network and no
//      cargo toolchain.
{
  const path = join(root, "Cargo.lock");
  const lock = readFileSync(path, "utf8");
  // Member names come from the members' own manifests, so a crate added or
  // renamed later needs no edit here.
  const memberManifests = [
    "Cargo.toml",
    "apps/desktop/src-tauri/Cargo.toml",
    ...readFileSync(join(root, "Cargo.toml"), "utf8")
      .split("\n")
      .map((line) => line.match(/^\s*"([^"]+)",?\s*$/))
      .filter(Boolean)
      .map((m) => join(m[1], "Cargo.toml")),
  ];
  const names = new Set();
  for (const rel of memberManifests) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // a glob entry in [workspace].members, not a directory
    }
    const m = text.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (m) names.add(m[1]);
  }
  if (names.size === 0) fail("found no workspace member names for Cargo.lock");

  // Rewrite the `version` line of each `[[package]]` block whose name is a
  // member. Blocks are separated by a blank line, so each is edited in place
  // without reformatting the rest of the file.
  let updated = 0;
  const blocks = lock.split("\n\n").map((block) => {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m);
    if (!name || !names.has(name[1])) return block;
    const next = block.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${version}"`);
    if (next !== block) updated += 1;
    return next;
  });
  if (updated !== names.size) {
    fail(
      `Cargo.lock: updated ${updated} of ${names.size} workspace members ` +
        `(${[...names].join(", ")}) -- is the lock stale? run a cargo command first`,
    );
  }
  writeFileSync(path, blocks.join("\n\n"));
  console.log(`updated Cargo.lock -> ${version} (${updated} workspace members)`);
}

// 2. Promote CHANGES.md: move the current `## Development` entries into a new
//    `## Version <v>` section and leave a fresh, empty `## Development`
//    heading above it. Empty sections are omitted entirely (no "- None."
//    placeholders), so the release notes carry only sections that have content.
const changesPath = join(root, "CHANGES.md");
const changes = readFileSync(changesPath, "utf8");
const lines = changes.split("\n");

const devIdx = lines.findIndex((line) => /^## Development$/.test(line));
if (devIdx === -1) {
  fail("CHANGES.md has no `## Development` section to promote");
}

// The Development block runs until the next `## ` heading (or end of file).
let nextIdx = lines.length;
for (let i = devIdx + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    nextIdx = i;
    break;
  }
}

const headText = lines.slice(0, devIdx).join("\n").replace(/\n+$/, "");
const devBody = lines.slice(devIdx + 1, nextIdx).join("\n");
const tailText = lines.slice(nextIdx).join("\n").replace(/^\n+/, "");

const promotedBody = stripEmptySections(devBody)
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const parts = [headText, "## Development", `## Version ${version}`];
if (promotedBody) parts.push(promotedBody);

let rebuilt = parts.join("\n\n");
if (tailText) rebuilt += "\n\n" + tailText;
rebuilt = rebuilt.replace(/\s+$/, "") + "\n";

writeFileSync(changesPath, rebuilt);
console.log(`promoted CHANGES.md -> ## Version ${version}`);

// Drop any `### ` subsection whose only content is the "- None." placeholder,
// so empty sections never reach the changelog or the release notes.
function stripEmptySections(body) {
  const bodyLines = body.split("\n");
  const out = [];
  let i = 0;
  while (i < bodyLines.length) {
    if (bodyLines[i].startsWith("### ")) {
      let j = i + 1;
      while (
        j < bodyLines.length &&
        !bodyLines[j].startsWith("### ") &&
        !bodyLines[j].startsWith("## ")
      ) {
        j++;
      }
      const content = bodyLines.slice(i + 1, j).join("\n").trim();
      if (content !== "- None.") out.push(...bodyLines.slice(i, j));
      i = j;
    } else {
      out.push(bodyLines[i]);
      i++;
    }
  }
  return out.join("\n");
}
