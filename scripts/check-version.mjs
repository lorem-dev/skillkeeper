#!/usr/bin/env node
// Verify every workspace package.json version matches the release tag.
// Usage: node scripts/check-version.mjs [tag]
// Tag falls back to $GITHUB_REF_NAME; a single leading `v` is stripped.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_FILES = [
  "package.json",
  "packages/i18n/package.json",
  "apps/desktop/package.json",
];

// The Tauri config carries its own top-level "version" field (JSON).
const TAURI_CONF = "apps/desktop/src-tauri/tauri.conf.json";

// Cargo manifests to validate. The root workspace declares the single source
// of truth under [workspace.package]; the tauri app crate inherits it via
// `version.workspace = true`, so we assert the workspace version here. Any
// crate that pins a literal `version = "..."` outside [workspace.*] would also
// be caught.
const CARGO_FILES = ["Cargo.toml", "apps/desktop/src-tauri/Cargo.toml"];

// Pull the version out of a Cargo.toml. Prefers the version declared under the
// [workspace.package] table; falls back to a literal `version` in [package].
// Returns null when the crate only inherits via `version.workspace = true`
// (nothing literal to compare against), so such crates are skipped, not failed.
function cargoVersion(text) {
  const lines = text.split("\n");
  let section = "";
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      continue;
    }
    if (section !== "workspace.package" && section !== "package") continue;
    const m = line.match(/^version\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!rawTag) {
  console.error("check-version: no tag given (arg or $GITHUB_REF_NAME)");
  process.exit(1);
}
const expected = rawTag.replace(/^v/, "");

const mismatches = [];
for (const rel of PACKAGE_FILES) {
  const { version } = JSON.parse(readFileSync(join(root, rel), "utf8"));
  if (version !== expected) {
    mismatches.push(`${rel}: ${version} (expected ${expected})`);
  }
}

// Tauri bundle config version.
{
  const { version } = JSON.parse(readFileSync(join(root, TAURI_CONF), "utf8"));
  if (version !== expected) {
    mismatches.push(`${TAURI_CONF}: ${version} (expected ${expected})`);
  }
}

// Rust crate / workspace versions.
for (const rel of CARGO_FILES) {
  const version = cargoVersion(readFileSync(join(root, rel), "utf8"));
  if (version === null) continue; // inherits via version.workspace; nothing literal to check
  if (version !== expected) {
    mismatches.push(`${rel}: ${version} (expected ${expected})`);
  }
}

if (mismatches.length > 0) {
  console.error(`check-version: tag ${rawTag} does not match package versions:`);
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

console.log(`check-version: all packages at ${expected}, matches ${rawTag}`);
