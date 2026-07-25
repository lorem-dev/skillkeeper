// Prepare the end-to-end run: make sure the fixture submodule is present and up
// to date, then build the binary the specs drive.
//
//     node scripts/e2e-prepare.mjs        (run for you by `pnpm test:e2e`)
//
// By default the fixture is force-pulled, not just initialized: the specs assert
// against the current fixture, and a stale checkout fails for reasons that have
// nothing to do with the code under test.
//
// One consequence worth knowing: force-pulling moves the submodule off the commit
// the superproject records, so `git status` will afterwards show
// `modified: examples/test-repo (new commits)`. This script never stages that.
// Restore the pinned commit with:
//
//     git submodule update -- examples/test-repo
//
// Or, to record the newer fixture on purpose, commit the pointer bump on its own.
//
// Set SKILLKEEPER_E2E_PIN_FIXTURE=1 to skip the pull and run against the commit
// this repository pins. CI does that: a build should be reproducible and fail for
// reasons in the diff, not because the fixture moved underneath it. Locally the
// default is the opposite -- pull, so fixture drift shows up early.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUBMODULE = 'examples/test-repo';
const SUBMODULE_DIR = join(ROOT, SUBMODULE);
const SUBMODULE_GIT = ['-C', SUBMODULE_DIR];

/** Run a command, inheriting stdio; exit the process on failure. */
function run(command, args, options = {}) {
  const printable = `${command} ${args.join(' ')}`;
  console.log(`> ${printable}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) {
    console.error(`failed to launch: ${printable}\n${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`command failed (${result.status}): ${printable}`);
    process.exit(result.status ?? 1);
  }
}

/** Run a command and return its trimmed stdout, or null when it fails. */
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/** Reset the fixture to the tip of its tracking branch, discarding local state. */
function forcePullFixture() {
  run('git', [...SUBMODULE_GIT, 'fetch', 'origin', '--prune', '--tags']);

  // Prefer the branch .gitmodules pins; fall back to the remote's default.
  let branch = capture('git', ['config', '-f', '.gitmodules', `submodule.${SUBMODULE}.branch`]);
  if (!branch) {
    const head = capture('git', [...SUBMODULE_GIT, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
    branch = head ? head.replace('refs/remotes/origin/', '') : 'main';
  }

  console.log(`fixture: resetting to origin/${branch}`);
  run('git', [...SUBMODULE_GIT, 'checkout', '--force', '-B', branch, `origin/${branch}`]);
  run('git', [...SUBMODULE_GIT, 'reset', '--hard', `origin/${branch}`]);
  run('git', [...SUBMODULE_GIT, 'clean', '-ffd']);

  const pinned = capture('git', ['rev-parse', `HEAD:${SUBMODULE}`]);
  const actual = capture('git', [...SUBMODULE_GIT, 'rev-parse', 'HEAD']);
  if (pinned && actual && pinned !== actual) {
    console.log(
      `\nnote: the fixture is now at ${actual.slice(0, 8)}, while this repository ` +
        `pins ${pinned.slice(0, 8)}.\n` +
        `      "git status" will show ${SUBMODULE} as modified. Restore the pin with\n` +
        `      "git submodule update -- ${SUBMODULE}", or commit the bump on its own.\n`,
    );
  }
}

// 1. Initialize the submodule. `--force` discards a dirty checkout, which is what
//    we want: it is a fixture, never a place to keep local edits.
run('git', ['submodule', 'sync', '--', SUBMODULE]);
run('git', ['submodule', 'update', '--init', '--force', '--', SUBMODULE]);

if (!existsSync(join(SUBMODULE_DIR, 'mcp.yml'))) {
  console.error(
    `submodule ${SUBMODULE} did not check out. If its SSH remote is unreachable, ` +
      'configure a GitHub key or run the suite where the fixture is available.',
  );
  process.exit(1);
}

// 2. Bring it up to date, unless the run is pinned.
if (process.env['SKILLKEEPER_E2E_PIN_FIXTURE'] === '1') {
  const at = capture('git', [...SUBMODULE_GIT, 'rev-parse', 'HEAD']);
  console.log(`fixture: pinned, staying at ${at ? at.slice(0, 8) : 'the recorded commit'}`);
} else {
  forcePullFixture();
}

// 3. Build the binary the specs drive. Debug is enough and much faster; the suite
//    exercises behaviour, not performance.
run('cargo', ['build', '-p', 'skillkeeper-cli']);

console.log('\ne2e prerequisites ready.');
