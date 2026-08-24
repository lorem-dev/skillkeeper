/**
 * Skills Management page: the per-project view of installed skills. One of the
 * two sub-pages the old combined `SkillsPage` split into (this one owns the
 * "projects" mode; the Components page owns the repositories browse mode) --
 * mirrors how the MCP page split into Components + Management.
 *
 * A tree of project -> ("repo / group" ->) skills, pre-checked where installed,
 * with a per-skill install-status badge (present / add / add-as-dependency /
 * remove / broken-dependency), non-clickable update dots plus a hover "update"
 * action where a newer version exists, and a per-project agent picker. "Save"
 * applies the diff via `SkillSaveModal`.
 * Project + repository multi-selects narrow which nodes appear; a search box
 * fuzzy-filters the tree; a footer summarizes the result and clears the
 * search/filters.
 *
 * The stored selection is the user's HAND PICKS plus the repairs asked for; the
 * dependency closure around them is derived per render (`entities/skill`'s
 * selection model) and is what the tree, the badges, the pending counts and the
 * save all read. Checking a skill therefore also checks what it requires, and
 * an installed skill whose dependency has gone missing -- or is about to, once
 * the pending selection is applied -- carries a clickable marker that arms the
 * whole missing closure for reinstall.
 *
 * View + selection state (query, filters, hand picks, per-project agents, tree
 * expansion) lives in the store's shared `skillsUi` slice so it survives
 * navigating between the two sub-pages and away/back. On mount this page pins
 * `skillsUi.mode` to 'projects' so the store discriminator,
 * `resetSkillsSelection`, and the deep-link router (App reads `skillsUi.mode`)
 * all agree with what is shown.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { GLOBAL_SCOPE_ID } from '@/domain';
import {
  Page,
  Toolbar,
  Button,
  ExpandingSearch,
  FilterButton,
  CollapsibleFilters,
  MultiCombobox,
  SearchSummary,
  TreeView,
  ChangeBadge,
  Badge,
  Tooltip,
  Icon,
} from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { useFilterToggle } from '@/shared/lib';
import { AgentSelect } from '@/entities/agent';
import { ProjectIcon } from '@/entities/project';
import {
  buildProjectModel,
  installedLeafIds,
  installedAgentsByProject,
  scopesNeedingAgents,
  filterTree,
  collectBranchIds,
  rootIds,
  countLeaves,
  projectSkillKey,
  projectNodeId,
  buildScopedGraph,
  brokenLeaves,
  pendingBrokenLeaves,
  contains,
  referenceKeys,
  deriveSelection,
  dropMissing,
  applyCheckChange,
  restore,
} from '@/entities/skill';
import { SkillSaveModal, AgentChoiceModal } from '@/features/skillSave';
import './SkillsPage.scss';

/** Whether two agent lists hold the same set. */
function sameAgents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function SkillsManagementPage() {
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const installs = useSkillkeeperStore((s) => s.skills);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const t = useTranslator();

  const skillsUi = useSkillkeeperStore((s) => s.skillsUi);
  const setSkillsUi = useSkillkeeperStore((s) => s.setSkillsUi);
  const resetSkillsSelection = useSkillkeeperStore((s) => s.resetSkillsSelection);
  const updateProjectSkills = useSkillkeeperStore((s) => s.updateProjectSkills);
  const requestAddRepository = useSkillkeeperStore((s) => s.requestAddRepository);
  const tasks = useSkillkeeperStore((s) => s.tasks);
  const {
    query,
    repoFilter,
    projectFilter,
    projectChecked,
    projectRestored,
    projectAgents,
    expandedIds: persistedExpandedIds,
  } = skillsUi;

  // Modal open flags are ephemeral -- they should not persist across navigation.
  const [saveOpen, setSaveOpen] = useState(false);
  const [agentChoiceOpen, setAgentChoiceOpen] = useState(false);

  // This sub-page IS the projects mode; keep the store discriminator in sync
  // (see the file header). Clear the shared search only when arriving from the
  // OTHER mode (mirrors the old in-page mode Select), while keeping it when
  // re-entering this mode. Project icons are resolved into projectInfo by the
  // Rust backend; refresh on mount so the project nodes can show them.
  useEffect(() => {
    const switching = useSkillkeeperStore.getState().skillsUi.mode !== 'projects';
    setSkillsUi(switching ? { mode: 'projects', query: '' } : { mode: 'projects' });
    void refreshProjectInfo();
  }, [setSkillsUi, refreshProjectInfo]);

  const setQuery = (value: string): void => setSkillsUi({ query: value });
  const setRepoFilter = (value: string[]): void => setSkillsUi({ repoFilter: value });
  const setProjectFilter = (value: string[]): void => setSkillsUi({ projectFilter: value });

  // The scopes a save reviews: the global scope first, then every tracked
  // project -- mirrors SkillSaveModal's own scope ordering, independent of the
  // current project/repo filters (a filtered-out project's pending changes
  // still need reviewing). Declared before the baseline below, which is scoped
  // to it.
  const scopeIds = useMemo(() => [GLOBAL_SCOPE_ID, ...projects.map((p) => p.id)], [projects]);

  // The installed skills are the baseline the selection diffs against
  // (pre-checked leaves + each project's installed agents).
  //
  // Scoped to `scopeIds` -- the same set the graph below spans -- because the
  // ledger outlives the project list: `projects::remove` drops the record and
  // keeps the installs, and `reconcile` preserves them on purpose. An unscoped
  // baseline would name leaves of a removed project, `dropMissing` would strip
  // them from the shown set (they are not nodes of the graph), and `pendingRemove`
  // would count them forever: a pending-changes dock with no row to uncheck,
  // which Save cannot clear either, since it iterates `scopeIds` too.
  const installedIds = useMemo(() => installedLeafIds(installs, scopeIds), [installs, scopeIds]);
  const installedSet = useMemo(() => new Set(installedIds), [installedIds]);
  const installedAgents = useMemo(() => installedAgentsByProject(installs), [installs]);

  // The dependency graph, drawn from the catalog UNIONED with the ledger, so an
  // orphan (installed, repository gone) still contributes the edges it was
  // installed with -- otherwise its broken state could not be detected. Keyed by
  // project-mode leaf id, because that is what this tree's checkboxes are: the
  // repo-mode graph would resolve none of them.
  const graph = useMemo(
    () => buildScopedGraph(scopeIds, availableSkills, installs),
    [scopeIds, availableSkills, installs],
  );

  // The selection, derived ONCE per render from the hand picks plus whatever
  // repairs were asked for. Everything below reads THIS value -- the tree's
  // checked set, the badges, the pending counts, and the diff every checkbox
  // change is computed against -- so the drawn state and the state clicks are
  // interpreted against cannot drift apart.
  const selection = useMemo(
    () =>
      dropMissing(graph, deriveSelection({ explicit: projectChecked, restored: projectRestored }, installedIds, graph)),
    [projectChecked, projectRestored, installedIds, graph],
  );
  const shownSet = useMemo(() => new Set(selection.shown), [selection]);

  /**
   * Fold a checkbox change from the tree into the stored selection.
   *
   * Diffed against `selection.shown` -- the exact set the tree was drawn from,
   * so the ids reported as changed are the ones the user really acted on. BOTH
   * halves are written back: unchecking a leaf whose repair was pending has to
   * clear that repair too, or the closure would keep re-seeding it and the box
   * would refuse to clear.
   */
  const onCheckedChange = (next: string[]): void => {
    const updated = applyCheckChange(
      { explicit: projectChecked, restored: projectRestored },
      installedIds,
      graph,
      selection.shown,
      next,
    );
    setSkillsUi({ projectChecked: [...updated.explicit], projectRestored: [...updated.restored] });
  };

  // Installed leaves missing a dependency, per scope, mapped to the missing
  // references. Evaluated over every scope the page reviews rather than only the
  // filtered ones, matching how `scopeIds` is used for the save diff.
  const brokenByLeaf = useMemo(() => {
    const all = new Map<string, string[]>();
    for (const scopeId of scopeIds) {
      for (const [leaf, missing] of brokenLeaves({ scopeId, available: availableSkills, installs })) {
        all.set(leaf, missing);
      }
    }
    return all;
  }, [scopeIds, availableSkills, installs]);

  // The same question asked of the PENDING state: installed leaves that still
  // stay checked but whose dependency the user has just unchecked. `brokenByLeaf`
  // reads the ledger, so it can only speak after Save -- when the skill is
  // already broken -- and unchecking a dependency is exactly the case it misses,
  // since an installed dependent is never dropped as collateral and so keeps its
  // "present" badge with nothing to say that saving will break it.
  //
  // Read off `selection.shown`, the same derived set the tree is drawn from, so
  // the warning and the checkboxes cannot disagree. Leaves broken today are
  // subtracted inside `pendingBrokenLeaves`, which is what keeps the two maps
  // disjoint and every row down to one marker.
  const pendingBrokenByLeaf = useMemo(() => {
    const all = new Map<string, string[]>();
    for (const scopeId of scopeIds) {
      for (const [leaf, missing] of pendingBrokenLeaves({
        scopeId,
        available: availableSkills,
        installs,
        selected: selection.shown,
      })) {
        all.set(leaf, missing);
      }
    }
    return all;
  }, [scopeIds, availableSkills, installs, selection]);

  // Of the broken leaves, the ones a repair could actually do something for: one
  // of the references they are MISSING names a skill that exists, i.e. is a node
  // of the graph, so some repository or ledger entry knows how to install it.
  //
  // Judged per agent, exactly like `brokenLeaves`, by asking about the missing
  // references it reports rather than about the leaf's whole closure: a
  // reference is only reported missing at a target where it is not installed, so
  // "not installed here yet" is already established and the only open question
  // is whether the skill exists at all. Testing the closure against the
  // leaf-level installed set instead judged a dependency installed for FEWER
  // agents than its dependent -- broken at the agents it is absent from, present
  // at the others -- as unrepairable, which left the row marked broken, offering
  // no click, and still carrying a tooltip inviting one.
  //
  // A leaf whose missing references name nothing that exists anywhere fails this
  // test, and its marker is rendered below with no click and a tooltip that
  // promises none: the click would arm a closure that `dropMissing` then
  // empties, so nothing would appear to happen. Where SOME of the missing
  // references are installable the leaf stays clickable and the marker stays
  // orange afterwards, which is exactly the truth: part of it was repaired, part
  // of it cannot be.
  //
  // Both maps are judged, by the same test: a pending break is caused by the
  // user's own uncheck, so its missing reference is a leaf installed TODAY and
  // therefore a node -- but a leaf can also be about to lose a reference that
  // exists nowhere, and that marker must not promise a click either.
  const repairableLeaves = useMemo(() => {
    const out = new Set<string>();
    for (const [leaf, missing] of [...brokenByLeaf, ...pendingBrokenByLeaf]) {
      if (referenceKeys(leaf, missing).some((key) => contains(graph, key))) out.add(leaf);
    }
    return out;
  }, [brokenByLeaf, pendingBrokenByLeaf, graph]);

  // Scopes whose checked skills would install nothing because no agent is
  // chosen -- Save opens the agent-choice modal first when this is non-empty.
  // Reads the derived set: a scope holding nothing but dependencies still needs
  // an agent to install them for.
  const needsAgents = useMemo(
    () => scopesNeedingAgents(scopeIds, selection.shown, installedIds, projectAgents),
    [scopeIds, selection, installedIds, projectAgents],
  );

  // Leaf ids whose skill ships a guidance file -> grey "rules" badge, keyed to
  // the project id scheme (one entry per project the skill could appear under,
  // plus the global scope -- a guidance-bearing skill installed user-wide gets
  // the badge too).
  const guidanceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of availableSkills) {
      if (!s.hasGuidance) continue;
      for (const p of projects) ids.add(projectSkillKey(p.id, s.repoId, s.group, s.name));
      ids.add(projectSkillKey(GLOBAL_SCOPE_ID, s.repoId, s.group, s.name));
    }
    return ids;
  }, [availableSkills, projects]);

  // The filters narrow which repos/projects appear (empty = all).
  const shownRepos = useMemo(
    () => (repoFilter.length === 0 ? repositories : repositories.filter((r) => repoFilter.includes(r.id))),
    [repositories, repoFilter],
  );
  const shownProjects = useMemo(
    () => (projectFilter.length === 0 ? projects : projects.filter((p) => projectFilter.includes(p.id))),
    [projects, projectFilter],
  );
  // The user-wide scope is one more entry in the projects filter, so it narrows
  // like any project: an empty filter shows everything, a non-empty one keeps the
  // Global root only when it was picked. A `null` label omits that root entirely
  // (see `treeScopes`) rather than leaving it standing while a filter is active.
  const showGlobal = projectFilter.length === 0 || projectFilter.includes(GLOBAL_SCOPE_ID);

  // Merge available skills with what is installed, so orphaned installs appear
  // (grey, remove-only) and update dots can be attached.
  const projectModel = useMemo(
    () =>
      buildProjectModel(
        availableSkills,
        shownRepos,
        repositories,
        shownProjects,
        installs,
        showGlobal ? t('scope.global') : null,
      ),
    [availableSkills, shownRepos, repositories, shownProjects, installs, showGlobal, t],
  );

  const baseTree = projectModel.nodes;
  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // An update-skill task in flight makes every dot pulse and non-clickable.
  const updatesBusy = useMemo(
    () => tasks.some((t) => t.kind === 'update-skill' && (t.status === 'queued' || t.status === 'running')),
    [tasks],
  );

  // Tag each visible skill leaf with its install-status badge, attach update
  // dots (leaf/group/repo) from the model, and give each project root an agent
  // picker (with an "agents changed" marker).
  const decorated = useMemo(() => {
    const rulesBadge = (
      <span className="sk-skills-badgewrap" onClick={(e) => e.stopPropagation()}>
        <Tooltip content={t('skills.rulesHint')}>
          <Badge tone="neutral">{t('skills.rulesBadge')}</Badge>
        </Tooltip>
      </span>
    );

    const dependencySet = new Set(selection.dependency);
    const { updatesByNode, orphanLeaves, statusByLeaf } = projectModel;
    // A node's label: name, then a non-interactive update dot when an update is
    // available, then a single action/status badge. The update action badge
    // shows only while the row is hovered; the unlinked/local status badges are
    // always visible. `updateTooltip` names the update scope.
    const buildLabel = (node: TreeNode, updateTooltip: string): ReactNode => {
      const ups = updatesByNode.get(node.id);
      const orphan = orphanLeaves.get(node.id);
      let badge: ReactNode = null;
      let hoverOnly = false;
      if (ups !== undefined) {
        hoverOnly = true;
        badge = (
          <Tooltip content={updateTooltip}>
            <button
              type="button"
              className="sk-skills-badge-btn"
              disabled={updatesBusy}
              onClick={() => {
                if (!updatesBusy) updateProjectSkills(ups);
              }}
            >
              <Badge tone="accent">{t('skills.updateBadge')}</Badge>
            </button>
          </Tooltip>
        );
      } else if (orphan?.kind === 'unlinked') {
        badge = (
          <Tooltip content={t('skills.addRepo')}>
            <button type="button" className="sk-skills-badge-btn" onClick={() => requestAddRepository(orphan.remote)}>
              <Badge tone="warning">{t('skills.unlinked')}</Badge>
            </button>
          </Tooltip>
        );
      } else if (orphan?.kind === 'local') {
        badge = (
          <Tooltip content={t('skills.localHint')}>
            <Badge tone="neutral">{t('skills.local')}</Badge>
          </Tooltip>
        );
      }
      const hasRules = guidanceIds.has(node.id);
      if (ups === undefined && badge === null && !hasRules) return node.label;
      return (
        <span className="sk-skills-nodelabel">
          <span className="sk-skills-name">{node.label}</span>
          {ups !== undefined && (
            <span className={`sk-skills-dot${updatesBusy ? ' sk-skills-dot--pulse' : ''}`} aria-hidden="true" />
          )}
          {badge !== null && (
            // Badges own their commands; swallow the click so it never reaches
            // the TreeView row (no accidental select/checkbox toggle).
            <span
              className={`sk-skills-badgewrap${hoverOnly ? ' sk-skills-badge--hover' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              {badge}
            </span>
          )}
          {hasRules && rulesBadge}
        </span>
      );
    };
    // Below a repo node: group branches vs skill leaves.
    const decorate = (node: TreeNode): TreeNode => {
      if (node.children !== undefined && node.children.length > 0) {
        return {
          ...node,
          label: buildLabel(node, t('skills.updateGroup')),
          children: node.children.map(decorate),
        };
      }
      const wasInstalled = installedSet.has(node.id);
      const isChecked = shownSet.has(node.id);
      const broken = brokenByLeaf.get(node.id);
      const pendingBroken = pendingBrokenByLeaf.get(node.id);
      const isDependency = dependencySet.has(node.id);
      let detail: ReactNode;
      // Broken outranks every pending change on the same row: it is a statement
      // about what IS installed, which matters more than a queued diff. A leaf
      // that is currently dependency-tinted is mid-repair, so it is excluded --
      // the tint already says the missing piece is coming back.
      if (broken !== undefined && !isDependency) {
        // Clickable only where a repair would install something (see
        // `repairableLeaves`); otherwise `ChangeBadge` falls back to its
        // non-interactive form. The tooltip follows the click rather than being
        // fixed: the clickable form says what to do, the other says why nothing
        // can be done, because a tooltip reading "Click to restore." on a badge
        // that is not a button states something untrue. The badge stops its own
        // click and its own Enter/Space, so the row behind it neither toggles nor
        // expands -- hence no `sk-skills-badgewrap` here, which would take its
        // keyboard handling out of the picture.
        const repairable = repairableLeaves.has(node.id);
        const repair = repairable
          ? () =>
              setSkillsUi({
                projectRestored: [
                  ...restore({ explicit: projectChecked, restored: projectRestored }, node.id).restored,
                ],
              })
          : undefined;
        detail = (
          <ChangeBadge
            kind="broken"
            label={t(repairable ? 'skills.status.brokenRequires' : 'skills.status.brokenRequiresUnavailable')}
            onClick={repair}
          />
        );
      }
      // The same marker for what the pending selection is ABOUT to break, and
      // deliberately ranked below the arm above: a leaf broken today shows
      // today's marker and today's tooltip, because a fact outranks a forecast.
      // The two arms are otherwise one rule, hence the same `!isDependency`
      // guard and the same repairability gate -- a tinted row cannot be
      // prospectively broken anyway (its dependent's closure re-adds whatever it
      // needs), and where nothing could be restored there is no click to offer
      // and no honest tooltip to offer it with, so the row falls through to its
      // ordinary badge and the after-apply marker reports it.
      else if (pendingBroken !== undefined && !isDependency && repairableLeaves.has(node.id)) {
        detail = (
          <ChangeBadge
            kind="broken"
            label={t('skills.status.brokenRequiresPending')}
            onClick={() =>
              setSkillsUi({
                projectRestored: [
                  ...restore({ explicit: projectChecked, restored: projectRestored }, node.id).restored,
                ],
              })
            }
          />
        );
      }
      // An installed skill held on by somebody else's dependency IS present --
      // it stays installed, and the teal checkbox already says why it is held.
      // No `!isDependency` guard here: it would leave that row the only
      // installed row in the tree with no badge at all.
      else if (wasInstalled && isChecked) detail = <ChangeBadge kind="present" label={t('skills.status.present')} />;
      else if (wasInstalled && !isChecked) detail = <ChangeBadge kind="remove" label={t('skills.status.remove')} />;
      else if (!wasInstalled && isChecked)
        detail = (
          <ChangeBadge
            kind={isDependency ? 'add-dependency' : 'add'}
            label={isDependency ? t('skills.status.addDependency') : t('skills.status.add')}
          />
        );
      else detail = undefined;
      // Installed-from-a-tracked-repo leaves (present/update) render their glyph
      // in the accent color, matching how installed MCP instances render blue --
      // available/orphan leaves keep the default gray.
      const status = statusByLeaf.get(node.id);
      const icon =
        status === 'present' || status === 'update' ? (
          <Icon name="skills" size={18} className="sk-skills-icon--installed" />
        ) : (
          node.icon
        );
      return { ...node, label: buildLabel(node, t('skills.updateSkill')), detail, icon };
    };
    return shownTree.map((root) => {
      const pid = root.id.replace(/^proj::/, '');
      const chosen = projectAgents[pid] ?? [];
      const changed = !sameAgents(chosen, installedAgents[pid] ?? []);
      const trailing = (
        <span className="sk-skills-agentctl" onClick={(e) => e.stopPropagation()}>
          {changed && (
            <span className="sk-skills-agentctl__changed" aria-label={t('skills.agentsChanged')}>
              <Icon name="sync" size={14} />
            </span>
          )}
          <AgentSelect
            value={chosen}
            onChange={(next) => setSkillsUi({ projectAgents: { ...projectAgents, [pid]: next } })}
            ariaLabel={t('skills.agentsLabel')}
            tooltip={t('skills.agentsTooltip')}
          />
        </span>
      );
      // Root's direct children are repository nodes (branches) and unmanaged
      // skills (leaves, present in the project but not from a tracked repo).
      const children = (root.children ?? []).map((child) =>
        child.children !== undefined && child.children.length > 0
          ? {
              ...child,
              label: buildLabel(child, t('skills.updateRepo')),
              children: child.children.map(decorate),
            }
          : decorate(child),
      );
      // The project's own icon (resolved + safety-checked in main) when it has
      // one; otherwise a generated placeholder -- via the shared ProjectIcon.
      // The global root shows the globe glyph instead of any project's icon.
      const projName = projects.find((p) => p.id === pid)?.name ?? pid;
      const icon =
        root.id === projectNodeId(GLOBAL_SCOPE_ID) ? (
          // `name` is unused once `global` is set (ProjectIcon returns the globe
          // glyph before touching it) but the prop type still requires one.
          <ProjectIcon global name="" size={18} />
        ) : (
          <ProjectIcon iconUrl={projectInfo[pid]?.iconDataUrl} name={projName} size={18} />
        );
      return { ...root, icon, trailing, children };
    });
  }, [
    projectModel,
    shownTree,
    guidanceIds,
    projectChecked,
    projectRestored,
    selection,
    shownSet,
    brokenByLeaf,
    pendingBrokenByLeaf,
    repairableLeaves,
    installedSet,
    projectAgents,
    installedAgents,
    projectInfo,
    projects,
    updatesBusy,
    updateProjectSkills,
    requestAddRepository,
    setSkillsUi,
    t,
  ]);

  const searching = query.trim() !== '';
  const filtering = repoFilter.length > 0 || projectFilter.length > 0;
  const totalSkills = useMemo(() => countLeaves(baseTree), [baseTree]);
  const shownSkills = useMemo(() => countLeaves(decorated), [decorated]);
  const baseExpandedIds = persistedExpandedIds ?? rootIds(baseTree);
  const expandedIds = searching ? [...new Set([...baseExpandedIds, ...collectBranchIds(decorated)])] : baseExpandedIds;

  // Pending change (drives the Save button + its notification). Counted from the
  // derived set, so a selection consisting only of dependencies still shows the
  // dock -- they are real installs.
  const pendingAdd = selection.shown.filter((id) => !installedSet.has(id)).length;
  const pendingRemove = useMemo(
    () => [...installedSet].filter((id) => !shownSet.has(id)).length,
    [shownSet, installedSet],
  );
  // Agents changing (even with no skill change) is a saveable diff too -- the
  // global scope's row is a live `AgentSelect` same as any project's, so its
  // pending agent change must count here too, or Save/Reset never appears.
  const agentsChangedAny = useMemo(
    () =>
      !sameAgents(projectAgents[GLOBAL_SCOPE_ID] ?? [], installedAgents[GLOBAL_SCOPE_ID] ?? []) ||
      projects.some((p) => !sameAgents(projectAgents[p.id] ?? [], installedAgents[p.id] ?? [])),
    [projects, projectAgents, installedAgents],
  );
  // A repair that is still outstanding is a saveable diff of its own. Where the
  // missing dependency is installed in this scope for FEWER agents than its
  // dependent, arming the repair adds nothing to the derived set -- the leaf is
  // already installed, hence already shown -- so `pendingAdd` cannot see it. The
  // diff exists only at (skill, agent) granularity, which the apply plan
  // resolves and a set of leaf ids cannot express. Without this term the badge
  // would accept the click and the dock would never offer the Save that performs
  // it. It clears itself: once the ledger satisfies the leaf, it is no longer
  // broken.
  const pendingRepair = useMemo(
    () => projectRestored.some((id) => brokenByLeaf.has(id) && repairableLeaves.has(id)),
    [projectRestored, brokenByLeaf, repairableLeaves],
  );
  const hasProjectChanges = pendingAdd > 0 || pendingRemove > 0 || agentsChangedAny || pendingRepair;

  // The user-wide scope leads the projects filter, mirroring its position as the
  // tree's first root.
  const projectOptions = [
    {
      value: GLOBAL_SCOPE_ID,
      label: t('scope.global'),
      icon: <ProjectIcon global name="" size={18} />,
    },
    ...projects.map((p) => ({
      value: p.id,
      label: p.name,
      icon: <ProjectIcon iconUrl={projectInfo[p.id]?.iconDataUrl} name={p.name} size={18} />,
    })),
  ];
  const repoOptions = repositories.map((r) => ({ value: r.id, label: r.name }));

  // Two filter controls (projects, repositories); the count badge shows how
  // many are non-empty and drives the collapsible filter row.
  const filterCount = (projectFilter.length > 0 ? 1 : 0) + (repoFilter.length > 0 ? 1 : 0);
  const filterToggle = useFilterToggle(filterCount);
  const clearFilters = (): void => {
    setProjectFilter([]);
    setRepoFilter([]);
  };

  const actions = (
    <>
      <ExpandingSearch
        glass
        label={t('common.search')}
        placeholder={t('common.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
        clearLabel={t('common.clear')}
      />
      <FilterButton
        count={filterCount}
        open={filterToggle.open}
        onToggle={filterToggle.toggle}
        onClear={clearFilters}
        filterLabel={t('common.filter')}
        clearLabel={t('common.clearFilters')}
      />
    </>
  );

  // Reset + Save live in the bottom dock; the whole dock is hidden (rather than
  // the buttons disabled) when there are no pending changes.
  const dock = hasProjectChanges
    ? [
        <Button key="reset" variant="secondary" glass onClick={() => resetSkillsSelection('projects')}>
          {t('skills.action.reset')}
        </Button>,
        <Button
          key="save"
          variant="primary"
          glass
          onClick={() => (needsAgents.length > 0 ? setAgentChoiceOpen(true) : setSaveOpen(true))}
        >
          {t('skills.action.save')}
        </Button>,
      ]
    : undefined;

  // Second toolbar row: the project + repository multi-select filters (projects
  // first). The project options carry a leading `ProjectIcon`.
  const filters = (
    <CollapsibleFilters
      open={filterToggle.visible}
      onFocusWithinChange={filterToggle.onFocusWithinChange}
      className="sk-skills-filters"
    >
      <MultiCombobox
        label={t('skills.filterProjects')}
        options={projectOptions}
        value={projectFilter}
        onChange={setProjectFilter}
        placeholder={t('skills.filterProjectsPlaceholder')}
        emptyText={t('skills.filterProjectsEmpty')}
        ariaLabel={t('skills.filterProjects')}
      />
      <MultiCombobox
        label={t('skills.filterRepositories')}
        options={repoOptions}
        value={repoFilter}
        onChange={setRepoFilter}
        placeholder={t('skills.filterRepositoriesPlaceholder')}
        emptyText={t('skills.filterRepositoriesEmpty')}
        ariaLabel={t('skills.filterRepositories')}
      />
    </CollapsibleFilters>
  );

  return (
    <Page
      toolbar={
        <div className="sk-skills-header">
          <Toolbar
            title={
              <>
                {t('nav.skills')}
                <span className="sk-skills-title-sep">/</span>
                {t('skills.managementTitle')}
              </>
            }
            trailing={actions}
          />
          {filters}
        </div>
      }
      dock={dock}
    >
      {/* An empty tree has two causes now that the Global root can be filtered
          out too (before this it was always present, so `baseTree` was never
          empty): nothing is tracked at all, or the filters excluded everything
          that is. Only the first is "no projects tracked yet"; the second must
          say so and carry its own reset, since the footer that normally holds
          one is inside the non-empty branch. */}
      {baseTree.length === 0 ? (
        filtering ? (
          <div className="sk-empty-filtered">
            <p className="sk-empty">{t('skills.emptyFiltered')}</p>
            <Button variant="secondary" onClick={clearFilters}>
              {t('skills.resetFilters')}
            </Button>
          </div>
        ) : (
          <p className="sk-empty">{t('skills.emptyProjects')}</p>
        )
      ) : (
        <>
          <TreeView
            className="sk-skills-tree"
            nodes={decorated}
            checkable
            checkedIds={selection.shown}
            dependencyIds={selection.dependency}
            onCheckedChange={onCheckedChange}
            defaultExpandedIds={expandedIds}
            onExpandedChange={(ids) => setSkillsUi({ expandedIds: ids })}
            ariaLabel={t('skills.managementTitle')}
          />
          {(searching || filtering) && (
            <div className="sk-list-footer">
              {searching && (
                <SearchSummary
                  foundLabel={t.plural('skills.searchFound', shownSkills)}
                  totalLabel={t.plural('skills.searchTotal', totalSkills)}
                  showAllLabel={t('skills.showAll')}
                  onShowAll={() => setQuery('')}
                />
              )}
              {filtering && (
                <div className="sk-skills-filter-reset">
                  <Button variant="secondary" onClick={clearFilters}>
                    {t('skills.resetFilters')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <AgentChoiceModal
        open={agentChoiceOpen}
        scopeIds={needsAgents}
        onCancel={() => setAgentChoiceOpen(false)}
        onConfirm={(chosen) => {
          setSkillsUi({ projectAgents: { ...projectAgents, ...chosen } });
          setAgentChoiceOpen(false);
          setSaveOpen(true);
        }}
      />
      <SkillSaveModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        checkedIds={selection.shown}
        projectAgents={projectAgents}
      />
    </Page>
  );
}
