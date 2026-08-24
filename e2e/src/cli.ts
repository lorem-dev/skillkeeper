/**
 * Harness for driving the built `skillkeeper` binary in isolation.
 *
 * Every run gets throwaway `HOME` and `XDG_CONFIG_HOME` directories. Both are
 * required, for different reasons:
 *
 * - `XDG_CONFIG_HOME` relocates `state.json` and `config.yaml`, so a run cannot
 *   mutate the developer's tracked repositories or install records.
 * - `HOME` relocates the agents' *global* roots. Codex MCP installs always write
 *   to `~/.codex/config.toml` regardless of the project, and global-scope skill
 *   installs write under `~`. Without this override a test would edit the
 *   developer's real agent configuration.
 *
 * A test that forgets either would silently corrupt the machine it runs on, so
 * the only way to invoke the CLI here is through `Sandbox`, which always sets
 * both.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Repository root, from this file's location (e2e/src -> ../..). */
export const REPO_ROOT = resolve(__dirname, '..', '..');

/** The fixture submodule's working tree. */
export const FIXTURE_DIR = join(REPO_ROOT, 'examples', 'test-repo');

/** The binary under test, produced by `cargo build -p skillkeeper-cli`. */
export const CLI_BIN = join(REPO_ROOT, 'target', 'debug', 'skillkeeper');

/** Result of one CLI invocation. Never throws on a non-zero exit: several tests
 *  assert on failure paths, so the status is data, not an exception. */
export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr interleaved by stream, for convenience in assertions. */
  readonly output: string;
}

/** Fail early with an actionable message rather than a confusing ENOENT. */
export function assertCliBuilt(): void {
  if (!existsSync(CLI_BIN)) {
    throw new Error(
      `CLI not built at ${CLI_BIN}. Run "pnpm test:e2e", which builds it first, ` +
        'or "cargo build -p skillkeeper-cli".',
    );
  }
}

/** Fail early when the fixture submodule was never checked out. */
export function assertFixtureCheckedOut(): void {
  if (!existsSync(join(FIXTURE_DIR, 'mcp.yml'))) {
    throw new Error(`Fixture submodule missing at ${FIXTURE_DIR}. Run "git submodule update --init".`);
  }
}

/**
 * An isolated CLI environment plus the scratch directories a test needs.
 *
 * Create one per spec file in `beforeAll` and `cleanup()` it in `afterAll`.
 */
export class Sandbox {
  /** Throwaway `HOME`: the agents' global roots resolve under here. */
  readonly home: string;
  /** Throwaway `XDG_CONFIG_HOME`: `state.json` and `config.yaml` live here. */
  readonly configHome: string;
  private readonly roots: string[] = [];

  constructor() {
    assertCliBuilt();
    this.home = this.makeRoot('home');
    this.configHome = this.makeRoot('config');
  }

  private makeRoot(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `skillkeeper-e2e-${label}-`));
    this.roots.push(dir);
    return dir;
  }

  /** A fresh scratch directory (a project, a clone destination, ...). */
  dir(label: string): string {
    return this.makeRoot(label);
  }

  /** Run the CLI with the isolated environment. `cwd` defaults to the sandbox
   *  home, so a command that acts on the current directory cannot accidentally
   *  act on the repository. */
  run(args: readonly string[], options: { cwd?: string } = {}): CliResult {
    const result = spawnSync(CLI_BIN, [...args], {
      cwd: options.cwd ?? this.home,
      encoding: 'utf8',
      // A hang has to fail, not stall the run. Jest's `testTimeout` cannot help
      // here: it is enforced on the event loop, and `spawnSync` blocks the loop
      // outright, so a CLI that never exits would hold the whole suite forever
      // with no output. The dependency specs make that a real risk -- a
      // traversal regression on the fixture's deliberate cycle would spin
      // rather than fail -- so the bound belongs on the child process.
      //
      // 60s is two orders of magnitude above any real invocation (the whole
      // suite runs in ~6s) and half of `testTimeout`, so the kill lands first
      // and surfaces as an ETIMEDOUT throw naming the binary. Same reasoning as
      // the `--version` probe in scripts/e2e-prepare.mjs.
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: this.home,
        XDG_CONFIG_HOME: this.configHome,
        // Keep output stable and parseable regardless of the developer's shell.
        NO_COLOR: '1',
        TERM: 'dumb',
      },
    });
    if (result.error !== undefined) throw result.error;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { status: result.status ?? 0, stdout, stderr, output: stdout + stderr };
  }

  /** Run the CLI and fail the test if it exited non-zero. */
  runOk(args: readonly string[], options: { cwd?: string } = {}): CliResult {
    const result = this.run(args, options);
    if (result.status !== 0) {
      throw new Error(
        `skillkeeper ${args.join(' ')} exited ${result.status}\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    return result;
  }

  /** Add the fixture as a tracked repository, cloned from the local working tree
   *  so the suite needs no network and no SSH key. Returns the clone path. */
  addFixtureRepo(name = 'fixture'): string {
    assertFixtureCheckedOut();
    const clone = join(this.dir('clone'), 'repo');
    this.runOk(['repo', 'add', FIXTURE_DIR, clone, '--name', name]);
    return clone;
  }

  /** Create and return a project directory. */
  project(label = 'project'): string {
    const dir = this.dir(label);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  cleanup(): void {
    for (const root of this.roots) rmSync(root, { recursive: true, force: true });
    this.roots.length = 0;
  }
}

/** Read a file as UTF-8, with the path in the error when it is missing. */
export function read(path: string): string {
  if (!existsSync(path)) throw new Error(`expected file to exist: ${path}`);
  return readFileSync(path, 'utf8');
}

/** Parse a JSON file, with the path in the error when it does not parse. */
export function readJson<T = unknown>(path: string): T {
  const text = read(path);
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON`, { cause });
  }
}
