// Ensure mkdocs (with the Material theme) is available, then optionally run a
// mkdocs subcommand.
//
// The documentation site is built with mkdocs + mkdocs-material, Python tools
// that are not part of the pnpm dependency graph. Rather than manage a Python
// virtualenv by hand, this leans on uv: a single `uv run --with mkdocs-material
// mkdocs ...` resolves and caches the tools on first use (later runs are
// instant) and needs no local virtualenv.
//
// Usage:
//   node scripts/ensure-mkdocs.mjs           # warm the tool cache
//   node scripts/ensure-mkdocs.mjs serve      # provision, then `mkdocs serve`
//   node scripts/ensure-mkdocs.mjs build      # provision, then `mkdocs build`
// Any extra args are forwarded to mkdocs (e.g. `... serve -a 0.0.0.0:9000`).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// mkdocs-material pulls in mkdocs itself, so a single package covers both.
const MKDOCS_DEPS = ['mkdocs-material'];
const WITH_ARGS = MKDOCS_DEPS.flatMap((pkg) => ['--with', pkg]);

const die = (message) => {
  console.error(`[skillkeeper] ${message}`);
  process.exit(1);
};

// uv drives the Python side; do not silently fall back to a bare `pip`/`venv`.
const uvProbe = spawnSync('uv', ['--version'], { stdio: 'ignore' });
if (uvProbe.error || uvProbe.status !== 0) {
  die(
    'uv is required to build the docs but was not found on PATH. Install it ' +
      '(https://docs.astral.sh/uv/getting-started/installation/), e.g. ' +
      '`curl -LsSf https://astral.sh/uv/install.sh | sh` or `brew install uv`, ' +
      'then re-run this command.',
  );
}

// Default to a cheap `--version` so `pnpm docs:install` just warms the cache.
const [subcommand = '--version', ...rest] = process.argv.slice(2);

// mkdocs.yml lives at the repo root, so run from there regardless of cwd.
const result = spawnSync('uv', ['run', ...WITH_ARGS, 'mkdocs', subcommand, ...rest], {
  stdio: 'inherit',
  cwd: repoRoot,
});
process.exit(result.status ?? 1);
