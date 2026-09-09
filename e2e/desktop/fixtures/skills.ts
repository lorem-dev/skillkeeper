/**
 * Scenarios for the Skills pages (flows 2, 3 and 11 -- see
 * `.superpowers/specs/2026-09-09-desktop-ui-e2e-design.md`).
 *
 * `projects_detect_agents`, `skills_apply` and `skills_list` carry no default
 * answer in `harness/commands.ts`: none is part of `store.loadAll`'s startup
 * round trip (see that file's doc comment), so `installable()` and
 * `withDependency()` -- both of which drive `SkillInstallModal` through a real
 * apply -- must supply all three themselves. `flatAndGrouped()` only browses,
 * so it needs none of them.
 *
 * Row identity: `entities/skill/lib/skillTree.tsx`'s `skill-row`/
 * `skill-install-checkbox` rows and `skill-group` rows carry each leaf/group's
 * OWN unique tree-node id, never a bare name or repo-relative path (mirrors
 * `mcpTree.tsx`'s "ROW IDENTITY" rule -- see that file's doc comment for why a
 * bare name is not unique). The functions below compute those same ids by
 * mirroring the builders the tree itself uses (`repoSkillKey`,
 * `projectSkillKey`, `projectGroupNodeId`) rather than guessing the format --
 * NOT by importing them: `skillTree.tsx` is `@/`-aliased JSX source, which
 * this directory's own, deliberately narrower `tsconfig.json` cannot resolve
 * (see `fixtures/mcp.ts`'s identical note on its own mirrors).
 */
import { withScenario } from '../harness/scenario.js';
import type { Scenario } from '../harness/scenario.js';
import type {
  Repository,
  Project,
  InstallManifest,
} from '../../../apps/desktop/src/renderer/services/bridge/generated/core/index.js';
import type { AvailableSkill, ApplyResult } from '../../../apps/desktop/src/renderer/services/bridge/contracts.js';

// -- row-identity mirrors (see this file's own doc comment) -----------------

/** Mirrors `entities/skill/lib/skillTree.tsx`'s `enc`. */
const enc = (part: string): string => encodeURIComponent(part);

/** Mirrors `entities/skill/lib/skillTree.tsx`'s `repoSkillKey` (the
 *  Components page's browse-tree leaf id, and `SkillInstallModal` step 1's
 *  source). */
function repoSkillKey(repoId: string, group: string | undefined, name: string): string {
  return [repoId, group ?? '', name].map(enc).join('::');
}

/** Mirrors `entities/skill/lib/skillTree.tsx`'s `projectSkillKey` (the
 *  Management page's leaf id, and `SkillInstallModal` step 2's checkbox id). */
function projectSkillKey(scopeId: string, repoId: string, group: string | undefined, name: string): string {
  return [scopeId, repoId, group ?? '', name].map(enc).join('::');
}

/** Mirrors `entities/skill/lib/skillTree.tsx`'s `projectGroupNodeId` (the
 *  Management page's group-branch id). */
function projectGroupNodeId(scopeId: string, repoId: string, group: string): string {
  return `${scopeId}::${repoId}::${group}`;
}

/** Mirrors `domain/scope.ts`'s `GLOBAL_SCOPE_ID`. */
const GLOBAL_SCOPE_ID = 'global';

/** The one repository every scenario below resolves its skills from. */
function repo(): Repository {
  return {
    id: 'skills-repo-id',
    name: 'skills-repo',
    url: 'https://example.invalid/skills-repo.git',
    kind: 'generic',
    transport: 'https',
    lfs: false,
    localPath: '/repos/skills-repo-id',
  };
}

/** The one tracked project `installable()`/`withDependency()` install into. */
function project(): Project {
  return { id: 'skills-project-id', path: '/projects/demo', name: 'Demo', addedAt: '2024-01-01T00:00:00Z' };
}

/**
 * `App`'s `activeView` starts at `'projects'` (see `App.tsx`), so `ProjectsPage`
 * mounts first on every `app.goto()`, regardless of which page the spec
 * navigates to afterward -- and with a non-empty `projects` array, its own
 * mount effect (`refreshProjectInfo` -> `projects_describe`) and its cards'
 * `OpenProjectButton` (`editors_list`) fire immediately, alongside the
 * app-wide `useProjectCheckSchedule` sweep (`projects_folder_state`). None of
 * the three has a default in `harness/commands.ts` (not part of `loadAll`'s
 * startup round trip), so any scenario carrying a tracked project must answer
 * them, exactly like `fixtures/repositories.ts`'s trio for the Repositories
 * page.
 */
function projectsPageStartupResponses(): Record<string, unknown> {
  return {
    editors_list: [],
    projects_describe: { skillCount: 0, fromReposCount: 0, agentCount: 0 },
    projects_folder_state: 'present',
  };
}

/**
 * Flow 2: a flat skill, a skill inside a group, and a skill inside a nested
 * group -- one repository's `skills_available` resolving to all three group
 * depths at once.
 */
export function flatAndGrouped(): Scenario {
  const repoId = repo().id;
  const skills: AvailableSkill[] = [
    {
      repoId,
      repoName: repo().name,
      remote: repo().url,
      name: 'flat-skill',
      contentHash: 'hash-flat-skill',
      hasGuidance: false,
    },
    {
      repoId,
      repoName: repo().name,
      remote: repo().url,
      group: 'platform',
      name: 'grouped-skill',
      contentHash: 'hash-grouped-skill',
      hasGuidance: false,
    },
    {
      repoId,
      repoName: repo().name,
      remote: repo().url,
      group: 'platform/lint',
      name: 'nested-skill',
      contentHash: 'hash-nested-skill',
      hasGuidance: false,
    },
  ];
  return withScenario({ repositories: [repo()], skills });
}

/** `flatAndGrouped()`'s flat skill's row id: the Management page has no
 *  tracked project, so only the reserved Global scope root shows. */
export function flatSkillLeafId(): string {
  return projectSkillKey(GLOBAL_SCOPE_ID, repo().id, undefined, 'flat-skill');
}

/** `flatAndGrouped()`'s top-level group's branch id. */
export function groupedSkillGroupId(): string {
  return projectGroupNodeId(GLOBAL_SCOPE_ID, repo().id, 'platform');
}

/** `flatAndGrouped()`'s nested group's branch id. */
export function nestedSkillGroupId(): string {
  return projectGroupNodeId(GLOBAL_SCOPE_ID, repo().id, 'platform/lint');
}

/**
 * Flow 3: one installable skill, plus the three commands `SkillInstallModal`'s
 * own round trip needs once it applies: `projects_detect_agents` (auto-picks
 * the chosen project's agents in step 1, so the spec never has to drive
 * `AgentSelect`'s own popup), `skills_apply` (the apply itself), and
 * `skills_list` (the post-apply refresh `applySkills` awaits before it
 * resolves).
 */
export function installable(): Scenario {
  const repoId = repo().id;
  const skills: AvailableSkill[] = [
    {
      repoId,
      repoName: repo().name,
      remote: repo().url,
      name: 'installable-skill',
      contentHash: 'hash-installable-skill',
      hasGuidance: false,
    },
  ];
  const applied: ApplyResult = { ok: true, installed: 1, removed: 0 };
  const ledgerAfterApply: InstallManifest[] = [];
  return withScenario({
    repositories: [repo()],
    projects: [project()],
    skills,
    responses: {
      ...projectsPageStartupResponses(),
      projects_detect_agents: ['claude'],
      skills_apply: applied,
      skills_list: ledgerAfterApply,
    },
  });
}

/** `installable()`'s skill's row id on the Components page's browse tree
 *  (`buildRepoTree`, repo-scoped, no project prefix). */
export function installableSkillRowId(): string {
  return repoSkillKey(repo().id, undefined, 'installable-skill');
}

/** `installable()`'s skill's checkbox id in `SkillInstallModal`'s step 2 tree
 *  (`buildProjectTree`), scoped to the one project the spec picks in step 1. */
export function installableSkillInstallCheckboxId(): string {
  return projectSkillKey(project().id, repo().id, undefined, 'installable-skill');
}

/**
 * Flow 11: a skill that `requires` another skill of the same repository (a
 * bare name -- `docs/usage/skills-and-hooks.md`'s "a reference is an absolute
 * skill path ... or bare `name` for an ungrouped skill"). Checking
 * `needs-dependency` must also select `depended-on-skill`, marked required.
 */
export function withDependency(): Scenario {
  const repoId = repo().id;
  const skills: AvailableSkill[] = [
    {
      repoId,
      repoName: repo().name,
      remote: repo().url,
      name: 'needs-dependency',
      requires: ['depended-on-skill'],
      contentHash: 'hash-needs-dependency',
      hasGuidance: false,
    },
    {
      repoId,
      repoName: repo().name,
      remote: repo().url,
      name: 'depended-on-skill',
      contentHash: 'hash-depended-on-skill',
      hasGuidance: false,
    },
  ];
  const applied: ApplyResult = { ok: true, installed: 2, removed: 0 };
  const ledgerAfterApply: InstallManifest[] = [];
  return withScenario({
    repositories: [repo()],
    projects: [project()],
    skills,
    responses: {
      ...projectsPageStartupResponses(),
      projects_detect_agents: ['claude'],
      skills_apply: applied,
      skills_list: ledgerAfterApply,
    },
  });
}

/** `withDependency()`'s dependent skill's row id on the Components page's
 *  browse tree (`buildRepoTree`, repo-scoped, no project prefix). */
export function needsDependencySkillRowId(): string {
  return repoSkillKey(repo().id, undefined, 'needs-dependency');
}

/** `withDependency()`'s dependency's checkbox id in `SkillInstallModal`'s
 *  step 2 tree (`buildProjectTree`), scoped to the one project the spec picks
 *  in step 1. */
export function dependedOnSkillInstallCheckboxId(): string {
  return projectSkillKey(project().id, repo().id, undefined, 'depended-on-skill');
}
