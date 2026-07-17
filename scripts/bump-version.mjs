#!/usr/bin/env node
// Bump the monorepo version and promote the CHANGES.md changelog.
// Usage: node scripts/bump-version.mjs <version>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_FILES = [
  "package.json",
  "packages/config/package.json",
  "packages/core/package.json",
  "packages/agents/package.json",
  "packages/i18n/package.json",
  "packages/cli/package.json",
  "apps/desktop/package.json",
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

// 2. Promote CHANGES.md: move the current `## Development` entries into a new
//    `## Version <v> - <date>` section and leave a fresh, empty `## Development`
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

const date = new Date().toISOString().slice(0, 10);
const parts = [headText, "## Development", `## Version ${version} - ${date}`];
if (promotedBody) parts.push(promotedBody);

let rebuilt = parts.join("\n\n");
if (tailText) rebuilt += "\n\n" + tailText;
rebuilt = rebuilt.replace(/\s+$/, "") + "\n";

writeFileSync(changesPath, rebuilt);
console.log(`promoted CHANGES.md -> ## Version ${version} - ${date}`);

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
