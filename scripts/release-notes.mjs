#!/usr/bin/env node
// Extract the CHANGES.md section for a released version into RELEASE_NOTES.md.
// Usage: node scripts/release-notes.mjs [tag]
// Tag falls back to $GITHUB_REF_NAME; a single leading `v` is stripped.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!rawTag) {
  console.error("release-notes: no tag given (arg or $GITHUB_REF_NAME)");
  process.exit(1);
}
const version = rawTag.replace(/^v/, "");

const changes = readFileSync(join(root, "CHANGES.md"), "utf8");
const lines = changes.split("\n");

// Match `## Version <version>` tolerating a trailing ` - <date>`.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingRe = new RegExp(`^## Version ${escaped}(\\s|$)`);

let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (headingRe.test(lines[i])) {
    start = i;
    break;
  }
}
if (start === -1) {
  console.error(`release-notes: no "## Version ${version}" section in CHANGES.md`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}

const body = lines.slice(start + 1, end).join("\n").trim();
if (body.length === 0) {
  console.error(`release-notes: section for ${version} is empty`);
  process.exit(1);
}

writeFileSync(join(root, "RELEASE_NOTES.md"), body + "\n");
console.log(body);
