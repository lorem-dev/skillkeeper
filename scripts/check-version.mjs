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
  "packages/config/package.json",
  "packages/core/package.json",
  "packages/agents/package.json",
  "packages/i18n/package.json",
  "packages/cli/package.json",
  "apps/desktop/package.json",
];

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

if (mismatches.length > 0) {
  console.error(`check-version: tag ${rawTag} does not match package versions:`);
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

console.log(`check-version: all packages at ${expected}, matches ${rawTag}`);
