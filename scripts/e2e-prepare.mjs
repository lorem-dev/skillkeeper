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
//
//    `-p skillkeeper-cli` is load-bearing, not tidiness: the desktop app crate is
//    itself named `skillkeeper` and its binary lands at the same
//    `target/debug/skillkeeper`, so a plain `cargo build` over the workspace
//    leaves whichever crate finished last at that path. Building the CLI package
//    explicitly puts the right one there.
run('cargo', ['build', '-p', 'skillkeeper-cli']);

// 4. Prove the binary at that path really is the CLI.
//
//    Step 3 normally guarantees this on its own: cargo re-links the CLI into
//    `target/debug` from its fingerprint cache even when nothing needs
//    recompiling, so it restores the right file after a desktop build put the GUI
//    app there. Measured, not assumed.
//
//    The assertion is here for when that stops holding -- a partial or
//    interrupted build, a hand-copied binary, a change in how cargo manages that
//    path. The failure it prevents is expensive to diagnose: the GUI app answers
//    nothing and waits in the window event loop, so every spec blocks with no
//    output and no error, which reads as a hung test runner rather than a wrong
//    binary.
assertCliBinary();

console.log('\ne2e prerequisites ready.');

/**
 * Fail loudly unless `target/debug/skillkeeper` answers `--version` like the CLI.
 *
 * The desktop app would instead open its event loop and never return, so the
 * check is a timeout as much as a string match.
 */
function assertCliBinary() {
  const bin = join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'skillkeeper.exe' : 'skillkeeper');
  console.log(`> ${bin} --version`);
  const result = spawnSync(bin, ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const printed = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const looksLikeCli = /^skillkeeper \S/.test(printed);
  if (result.error !== undefined || result.status !== 0 || !looksLikeCli) {
    console.error(
      `\n${bin} did not respond as the CLI.\n\n` +
        `Got: ${printed === '' ? '(no output)' : printed}\n\n` +
        'The desktop app crate is also named `skillkeeper` and writes the same\n' +
        'path, so something rebuilt it over the CLI -- most likely a workspace-wide\n' +
        '`cargo build` or `cargo test`. Rebuild the CLI and retry:\n\n' +
        '    cargo build -p skillkeeper-cli\n',
    );
    process.exit(1);
  }
  console.log(printed);
}
