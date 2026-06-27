// Ensure the Electron binary is present after `pnpm install`.
//
// pnpm gates dependency build scripts, which can skip Electron's own download
// step. When that happens, `pnpm --filter @skillkeeper/desktop dev` fails with
// "Error: Electron uninstall" because the binary was never fetched. This runs
// Electron's installer once (the download is cached globally, so later installs
// are fast and this becomes a no-op).
//
// Skipped in CI: the build and packaging jobs do not need the dev binary, and
// electron-builder downloads its own Electron during packaging.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

if (process.env.CI) {
  process.exit(0);
}

// Resolve Electron from the desktop app, which is the package that depends on it.
const require = createRequire(join(process.cwd(), 'apps/desktop/package.json'));

let packageDir;
try {
  packageDir = dirname(require.resolve('electron/package.json'));
} catch {
  // Electron is not installed (for example a libs-only install); nothing to do.
  process.exit(0);
}

const alreadyInstalled =
  existsSync(join(packageDir, 'path.txt')) && existsSync(join(packageDir, 'dist'));
if (alreadyInstalled) {
  process.exit(0);
}

console.log('[skillkeeper] Fetching the Electron binary (one-time, cached afterwards)...');
execFileSync(process.execPath, [join(packageDir, 'install.js')], { stdio: 'inherit' });
