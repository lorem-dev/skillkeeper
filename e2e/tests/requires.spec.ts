/**
 * Skill dependencies end to end: `repo lint` over the fixture's `requires`
 * group, and the install/uninstall halves of the dependency closure.
 *
 * The fixture carries one skill per dependency behaviour (see its README's
 * "Skill dependencies" section), so these specs assert on diagnostic *codes*
 * rather than prose: the codes are the stable contract, the messages are not.
 *
 * `repo lint` needs no tracked repository -- `--path` reads a working tree
 * directly -- but it still runs through `Sandbox`, because every CLI invocation
 * in this suite must have the throwaway `HOME` and `XDG_CONFIG_HOME`.
 */
import { join } from 'node:path';
import { read, Sandbox, FIXTURE_DIR } from '../src/cli';

/** One `repo lint --json` item. `path` and `file` are null when unattributed. */
interface LintItem {
  readonly repository: string;
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly path: string | null;
  readonly file: string | null;
  readonly message: string;
}

describe('repo lint', () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = new Sandbox();
  });

  afterAll(() => sandbox.cleanup());

  it('exits 1 and names every dependency fault in the fixture', () => {
    const result = sandbox.run(['repo', 'lint', '--path', FIXTURE_DIR]);
    // Errors fail the run. SK004 (the too-deep skill) already did that before
    // the dependency fixtures existed, so the exit code is not what the new
    // codes prove -- their presence is.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('SK001'); // requires/missing-target
    expect(result.stdout).toContain('SK002'); // requires/cycle-a + cycle-b
    expect(result.stdout).toContain('SK003'); // requires/invalid-strict
    expect(result.stdout).toContain('SK005'); // requires/declared-hook-missing
    expect(result.stdout).toContain('SK010'); // requires/flat-legacy
    expect(result.stdout).toContain('SK011'); // requires/both-forms
    expect(result.stdout).toContain('SK012'); // requires/duplicate
    expect(result.stdout).toContain('SK013'); // requires/missing-executable
    // A cycle is named by its members, comma-separated. Deliberately not an
    // arrow chain: the finding is a strongly connected component, so a
    // specific edge path would be invented.
    expect(result.stdout).toContain('Dependency cycle among: requires/cycle-a, requires/cycle-b.');
  });

  it('emits parseable JSON with --json', () => {
    const result = sandbox.run(['repo', 'lint', '--path', FIXTURE_DIR, '--json']);
    expect(result.status).toBe(1);
    // Exactly one document on stdout, not one object per line.
    const items = JSON.parse(result.stdout) as LintItem[];
    expect(Array.isArray(items)).toBe(true);
    // Every code, with the `path` it actually carries. Attribution is not
    // uniform, and the split is by design rather than an oversight:
    //
    // - The graph-derived findings name the declaring skill. SK002 names the
    //   first member of the strongly connected component, not every member --
    //   one finding per cycle, so `requires/cycle-b` is in the message but not
    //   in `path`.
    // - The per-skill manifest checks (SK005, SK010, SK013) name the skill and
    //   also carry `file`.
    // - SK003, SK011, and SK012 are `null` by design: they are manifest-parser
    //   and resolver prose that the lint pass reclassifies, not findings
    //   derived from a resolved skill. SK003's skill never resolved at all, so
    //   there is nothing to attribute it to; SK011 and SK012 name their file in
    //   the message text instead.
    const has = (code: string, severity: string, path: string | null) =>
      items.some((d) => d.code === code && d.severity === severity && d.path === path);
    expect(has('SK001', 'error', 'requires/missing-target')).toBe(true);
    expect(has('SK002', 'error', 'requires/cycle-a')).toBe(true);
    expect(has('SK003', 'error', null)).toBe(true);
    expect(has('SK005', 'error', 'requires/declared-hook-missing')).toBe(true);
    expect(has('SK010', 'warning', 'requires/flat-legacy')).toBe(true);
    expect(has('SK011', 'warning', null)).toBe(true);
    expect(has('SK012', 'warning', null)).toBe(true);
    expect(has('SK013', 'warning', 'requires/missing-executable')).toBe(true);
    // SK002 is reported once for the pair, so `requires/cycle-b` is named in
    // the message but is never itself an attributed path.
    expect(items.filter((d) => d.code === 'SK002')).toHaveLength(1);
    expect(items.some((d) => d.path === 'requires/cycle-b')).toBe(false);
    // The four unattributed codes still identify their manifest somewhere: the
    // two leniency notes carry the file in their prose.
    expect(
      items.some((d) => d.code === 'SK011' && d.message.includes('requires/both-forms/SKILL.md')),
    ).toBe(true);
    expect(
      items.some((d) => d.code === 'SK012' && d.message.includes('requires/duplicate/SKILL.md')),
    ).toBe(true);
    expect(
      items.some((d) => d.code === 'SK003' && d.message.includes('requires/invalid-strict/SKILL.md')),
    ).toBe(true);
    // A valid reference into another group is not a finding of any kind. This is
    // the case that would break if reference lookup were scoped to the
    // declaring skill's own group directory.
    expect(items.filter((d) => d.path === 'requires/cross-group')).toEqual([]);
    // Precedence, observably: `requires/both-forms` also carries a flat
    // `requires` naming `requires/ignored-by-precedence`, which does not exist.
    // Reading that list would produce a second SK001 for it; the namespaced
    // list winning is why no diagnostic mentions it at all.
    expect(items.filter((d) => d.message.includes('ignored-by-precedence'))).toEqual([]);
  });

  it('rejects more than one target', () => {
    const result = sandbox.run(['repo', 'lint', '--all', '--path', FIXTURE_DIR]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('exactly one');
    // A usage failure never prints the clean message: the gate did not run.
    expect(result.stdout).not.toContain('No problems found.');
  });

  it('rejects no target at all', () => {
    const result = sandbox.run(['repo', 'lint']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('exactly one');
    expect(result.stdout).not.toContain('No problems found.');
  });
});

describe('skill install with dependencies', () => {
  let sandbox: Sandbox;

  beforeAll(() => {
    sandbox = new Sandbox();
    sandbox.addFixtureRepo();
  });

  afterAll(() => sandbox.cleanup());

  // Ordered: the uninstall case takes apart what the install case built. Global
  // scope on purpose -- `uninstall` takes no `--project` and acts on the
  // current directory, which for this harness is the throwaway HOME.
  it('installs the whole chain when only its head is named', () => {
    const result = sandbox.run([
      'skill',
      'install',
      'requires/chain-a',
      '--agent',
      'claude',
      '--global',
    ]);
    expect(result.status).toBe(0);
    // Two hops, so transitivity rather than a single lookup: `chain-c` is named
    // only by `chain-b`, never by the skill the user asked for.
    expect(result.stdout).toContain('Skill installed: requires/chain-a');
    expect(result.stdout).toContain('Skill installed as a dependency: requires/chain-b');
    expect(result.stdout).toContain('Skill installed as a dependency: requires/chain-c');

    const listed = sandbox.runOk(['skill', 'list']).stdout;
    expect(listed).toContain('requires/chain-a');
    expect(listed).toContain('requires/chain-b');
    expect(listed).toContain('requires/chain-c');
  });

  it('warns when uninstalling a skill another installed skill needed', () => {
    const result = sandbox.run(['skill', 'uninstall', 'requires/chain-b']);
    // Uninstall never cascades, and reporting the breakage does not change the
    // exit code: the report says what broke, acting on it is the user's call.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Uninstalled: chain-b');
    expect(result.stderr).toContain('Skill "requires/chain-a" is still installed');
    expect(result.stderr).toContain('"requires/chain-b"');
    expect(result.stderr).toContain('just removed');

    // The head and the tail survive; only the named link went away.
    const listed = sandbox.runOk(['skill', 'list']).stdout;
    expect(listed).toContain('requires/chain-a');
    expect(listed).not.toContain('requires/chain-b');
    expect(listed).toContain('requires/chain-c');
  });
});

/**
 * The two behaviours the fixture's README promises but nothing else asserts.
 * Both are documented on the page a contributor reads, so a regression in
 * either would be silent.
 *
 * Project scope here, not global: the cross-group case needs a guidance file to
 * inspect, and `uninstall` is documented as acting on the current directory, so
 * it is run with `cwd` set to that project.
 */
describe('skill install: cycles and cross-group references', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = new Sandbox();
    sandbox.addFixtureRepo();
  });

  afterEach(() => sandbox.cleanup());

  it('terminates on a dependency cycle and installs both members', () => {
    // `requires/cycle-a` and `requires/cycle-b` require each other. The claim
    // in cycle-a/SKILL.md is that install "visits each member once and exits 0
    // with both skills installed. A cycle is a repository defect worth
    // reporting, not a reason to hang or to refuse."
    //
    // Termination is the assertion that matters and the reason this test earns
    // its place: a traversal regression would spin or recurse rather than fail,
    // and a hanging install is far worse than a wrong one. `Sandbox.run` bounds
    // the child process precisely so that shows up as a failure -- Jest's own
    // `testTimeout` cannot interrupt the synchronous `spawnSync`.
    const project = sandbox.project();
    const result = sandbox.run([
      'skill', 'install', 'requires/cycle-a', '--agent', 'claude', '--project', project,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skill installed: requires/cycle-a');
    expect(result.stdout).toContain('Skill installed as a dependency: requires/cycle-b');

    // Both members really landed, rather than the command merely exiting 0.
    const listed = sandbox.runOk(['skill', 'list']).stdout;
    expect(listed).toContain('requires/cycle-a');
    expect(listed).toContain('requires/cycle-b');
    const skills = join(project, '.claude', 'skills');
    expect(read(join(skills, 'cycle-a', 'SKILL.md'))).toContain('name: cycle-a');
    expect(read(join(skills, 'cycle-b', 'SKILL.md'))).toContain('name: cycle-b');

    // Visited once each: a second ledger entry would be the duplicate the
    // "already installed" guard exists to prevent.
    expect(listed).toContain('2 skill(s) installed');
  });

  it('pulls in a cross-group dependency and leaves its guidance block on uninstall', () => {
    // The fixture README's exact claim, under "Things to try": "Install
    // `requires/cross-group` and then uninstall it. `tooling/lint-skill` came
    // in as its dependency and ships a `GUIDE.md`, so its guidance block must
    // survive - the dependency is still installed in its own right."
    const project = sandbox.project();
    const installed = sandbox.run([
      'skill', 'install', 'requires/cross-group', '--agent', 'claude', '--project', project,
    ]);
    expect(installed.status).toBe(0);
    // Two groups away, and named by its full `group/name` id: the bare
    // `lint-skill` would not be the same reference.
    expect(installed.stdout).toContain('Skill installed as a dependency: tooling/lint-skill');

    // Claude's guidance target is `.claude/CLAUDE.md` when the project has no
    // top-level CLAUDE.md. `cross-group` itself ships neither guidance file, so
    // the one block present belongs to the dependency the user never named.
    const guidance = () => read(join(project, '.claude', 'CLAUDE.md'));
    expect(guidance()).toMatch(/SKILLKEEPER_START:.*tooling\/lint-skill/);
    expect(guidance()).toContain('tooling/lint-skill (from GUIDE.md)');
    expect(guidance().match(/SKILLKEEPER_START/g) ?? []).toHaveLength(1);

    // `uninstall` takes no `--project` and acts on the current directory.
    const removed = sandbox.run(['skill', 'uninstall', 'requires/cross-group'], { cwd: project });
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain('Uninstalled: cross-group');

    // The claim: the block survives, because the dependency is still installed
    // in its own right. A block is only removed once no remaining install
    // claims it.
    expect(guidance()).toMatch(/SKILLKEEPER_START:.*tooling\/lint-skill/);
    expect(guidance()).toContain('tooling/lint-skill (from GUIDE.md)');
    const listed = sandbox.runOk(['skill', 'list']).stdout;
    expect(listed).toContain('tooling/lint-skill');
    expect(listed).not.toContain('requires/cross-group');
    // Its body survives too, not just the ledger row.
    expect(read(join(project, '.claude', 'skills', 'lint-skill', 'SKILL.md'))).toContain(
      'name: lint-skill',
    );
  });
});
