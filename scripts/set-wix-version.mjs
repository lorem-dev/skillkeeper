#!/usr/bin/env node
// Derive an MSI-compatible ProductVersion and write it into
// bundle.windows.wix.version of the Tauri config. The msi bundle target
// requires a numeric major.minor.patch[.build] version, but the app version
// carries a non-numeric pre-release (e.g. 0.1.0-rc.2) that msi rejects. Only
// the MSI version is affected; every other bundle keeps Config.version.
//
//   0.1.0-rc.N -> 0.1.0.N   (the rc number becomes the 4th field)
//   0.1.0       -> 0.1.0
//
// This mutates the checkout in place and is meant to run in CI on the Windows
// build leg, just before `tauri build`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));

const version = conf.version;
const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
if (!match) {
  console.error(
    `set-wix-version: unsupported version "${version}"; expected X.Y.Z or X.Y.Z-rc.N`,
  );
  process.exit(1);
}

const [, major, minor, patch, rc] = match;
const wixVersion =
  rc === undefined
    ? `${major}.${minor}.${patch}`
    : `${major}.${minor}.${patch}.${rc}`;

conf.bundle ??= {};
conf.bundle.windows ??= {};
conf.bundle.windows.wix ??= {};
conf.bundle.windows.wix.version = wixVersion;

writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
console.log(
  `set-wix-version: bundle.windows.wix.version = ${wixVersion} (from ${version})`,
);
