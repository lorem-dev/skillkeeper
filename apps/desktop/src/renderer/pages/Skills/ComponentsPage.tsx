/**
 * Skills Components page: browse available skills by repository and check the
 * ones to install. One of the two sub-pages the old combined `SkillsPage` split
 * into (this one owns the "repositories" browse mode; the Management page owns
 * the per-project installed view) -- mirrors how the MCP page split into
 * Components (presets browser) + Management (installed instances).
 *
 * A tree of repo -> (group ->) skills, checkable to build an install set;
 * checking a skill also checks what it requires, tinted to say so. "Install"
 * (Add) opens `SkillInstallModal` for the EXPLICIT picks -- the modal derives the
 * closure itself, against the chosen project's own installed set. A repo
 * multi-select narrows which repositories appear; a search box fuzzy-filters
 * the tree; a footer summarizes the result and clears the search/filter.
 *
 * View state (query, repo filter, checked set, tree expansion) lives in the
 * store's shared `skillsUi` slice so it survives navigating between the two
 * sub-pages and away/back. On mount this page pins `skillsUi.mode` to
 * 'repositories' so the store discriminator, `resetSkillsSelection`, and the
 * deep-link router (App reads `skillsUi.mode`) all agree with what is shown.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
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
} from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { useFilterToggle } from '@/shared/lib';
import {
  buildRepoTree,
  filterTree,
  collectBranchIds,
  rootIds,
  countLeaves,
  repoSkillKey,
  buildGraph,
  deriveSelection,
  dropMissing,
  applyCheckChange,
} from '@/entities/skill';
import { SkillInstallModal } from '@/features/skillInstall';
import './SkillsPage.scss';

/**
 * Repositories mode has no installed baseline: nothing here is "already
 * present", so every check seeds its own dependency closure -- the first-install
 * case. Module-level so the memos below see a stable reference.
 */
const NO_BASELINE: readonly string[] = [];

/** No repair can be pending in a mode with no baseline to repair against. */
const NO_RESTORED: readonly string[] = [];

export function SkillsComponentsPage() {
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const t = useTranslator();

  const skillsUi = useSkillkeeperStore((s) => s.skillsUi);
  const setSkillsUi = useSkillkeeperStore((s) => s.setSkillsUi);
  const resetSkillsSelection = useSkillkeeperStore((s) => s.resetSkillsSelection);
  const { query, repoFilter, repoChecked, expandedIds: persistedExpandedIds } = skillsUi;

  // Modal open flag is ephemeral -- it should not persist across navigation.
  const [installOpen, setInstallOpen] = useState(false);

  // This sub-page IS the repositories browse mode; keep the store discriminator
  // in sync (see the file header). Clear the shared search only when arriving
  // from the OTHER mode -- mirrors the old in-page mode Select, which reset the
  // query on switch -- while keeping it when re-entering this mode (navigating
  // away and back).
  useEffect(() => {
    const switching = useSkillkeeperStore.getState().skillsUi.mode !== 'repositories';
    setSkillsUi(switching ? { mode: 'repositories', query: '' } : { mode: 'repositories' });
  }, [setSkillsUi]);

  const setQuery = (value: string): void => setSkillsUi({ query: value });
  const setRepoFilter = (value: string[]): void => setSkillsUi({ repoFilter: value });
  const setRepoChecked = (ids: string[]): void => setSkillsUi({ repoChecked: ids });

  // Leaf ids whose skill ships a GUIDE.md/RULES.md guidance file -- they get a
  // grey "rules" badge, keyed to the repo id scheme.
  const guidanceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of availableSkills) {
      if (s.hasGuidance) ids.add(repoSkillKey(s.repoId, s.group, s.name));
    }
    return ids;
  }, [availableSkills]);

  // The repo filter narrows which repositories appear (empty = all).
  const shownRepos = useMemo(
    () => (repoFilter.length === 0 ? repositories : repositories.filter((r) => repoFilter.includes(r.id))),
    [repositories, repoFilter],
  );

  // `repoChecked` holds the hand picks only; the dependency closure is derived.
  // Derived ONCE per render: the tree is drawn from this exact value and every
  // checkbox change is diffed against the same `shown`, so the two can never
  // disagree (see `applyCheckChange`, which diffs against what was drawn).
  const graph = useMemo(() => buildGraph(availableSkills, []), [availableSkills]);
  const selection = useMemo(
    () => dropMissing(graph, deriveSelection({ explicit: repoChecked, restored: NO_RESTORED }, NO_BASELINE, graph)),
    [repoChecked, graph],
  );

  const baseTree = useMemo(() => buildRepoTree(availableSkills, shownRepos), [availableSkills, shownRepos]);
  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // Repo mode has no INSTALL-status decoration -- present/add/remove are
  // statements about a scope, and nothing is installed into a repository. It
  // does carry a dependency marker, because dependencies are selected in this
  // very mode: without it the only signal that a box was ticked for the user
  // rather than by them is the teal checkbox tone, which is colour alone and
  // says nothing to a screen reader. Plus the grey "rules" badge on skills that
  // ship guidance.
  const decorated = useMemo(() => {
    const dependencySet = new Set(selection.dependency);
    if (guidanceIds.size === 0 && dependencySet.size === 0) return shownTree;
    const rulesBadge = (
      <span className="sk-skills-badgewrap" onClick={(e) => e.stopPropagation()}>
        <Tooltip content={t('skills.rulesHint')}>
          <Badge tone="neutral">{t('skills.rulesBadge')}</Badge>
        </Tooltip>
      </span>
    );
    const walk = (node: TreeNode): TreeNode => {
      if (node.children !== undefined && node.children.length > 0) {
        return { ...node, children: node.children.map(walk) };
      }
      const hasRules = guidanceIds.has(node.id);
      // The badge carries the accessible name, so the tint is never the only
      // thing that says a skill was selected as somebody else's dependency.
      const detail: ReactNode = dependencySet.has(node.id) ? (
        <ChangeBadge kind="add-dependency" label={t('skills.status.addDependency')} />
      ) : undefined;
      if (!hasRules) return detail === undefined ? node : { ...node, detail };
      return {
        ...node,
        detail,
        label: (
          <span className="sk-skills-nodelabel">
            <span className="sk-skills-name">{node.label}</span>
            {rulesBadge}
          </span>
        ),
      };
    };
    return shownTree.map(walk);
  }, [shownTree, guidanceIds, selection, t]);

  const searching = query.trim() !== '';
  const filtering = repoFilter.length > 0;
  const totalSkills = useMemo(() => countLeaves(baseTree), [baseTree]);
  const shownSkills = useMemo(() => countLeaves(decorated), [decorated]);
  // Seed from the persisted expansion (falling back to the roots the first
  // time); while searching, union in the match branches so matches auto-open
  // without collapsing anything the user had open.
  const baseExpandedIds = persistedExpandedIds ?? rootIds(baseTree);
  const expandedIds = searching ? [...new Set([...baseExpandedIds, ...collectBranchIds(decorated)])] : baseExpandedIds;

  const repoOptions = repositories.map((r) => ({ value: r.id, label: r.name }));

  // One filter control (repositories); drives the count badge + collapsible row.
  const filterCount = repoFilter.length > 0 ? 1 : 0;
  const filterToggle = useFilterToggle(filterCount);

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
        onClear={() => setRepoFilter([])}
        filterLabel={t('common.filter')}
        clearLabel={t('common.clearFilters')}
      />
    </>
  );

  // Reset + Install live in the bottom dock; the whole dock is hidden (rather
  // than the buttons disabled) when nothing is checked.
  // Keyed off the DERIVED set: a selection made only of dependencies (every hand
  // pick filtered out of the tree, say) is still a selection.
  const dock =
    selection.shown.length > 0
      ? [
          <Button key="reset" variant="secondary" glass onClick={() => resetSkillsSelection('repositories')}>
            {t('skills.action.reset')}
          </Button>,
          <Button key="add" variant="primary" glass onClick={() => setInstallOpen(true)}>
            {t('skills.action.add')}
          </Button>,
        ]
      : undefined;

  // Second toolbar row: the repository multi-select filter.
  const filters = (
    <CollapsibleFilters
      open={filterToggle.visible}
      onFocusWithinChange={filterToggle.onFocusWithinChange}
      className="sk-skills-filters"
    >
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
                {t('skills.componentsTitle')}
              </>
            }
            trailing={actions}
          />
          {filters}
        </div>
      }
      dock={dock}
    >
      {baseTree.length === 0 ? (
        <p className="sk-empty">{t('skills.emptyRepositories')}</p>
      ) : (
        <>
          <TreeView
            className="sk-skills-tree"
            nodes={decorated}
            checkable
            checkedIds={selection.shown}
            dependencyIds={selection.dependency}
            onCheckedChange={(next) =>
              setRepoChecked([
                ...applyCheckChange(
                  { explicit: repoChecked, restored: NO_RESTORED },
                  NO_BASELINE,
                  graph,
                  selection.shown,
                  next,
                ).explicit,
              ])
            }
            defaultExpandedIds={expandedIds}
            onExpandedChange={(ids) => setSkillsUi({ expandedIds: ids })}
            ariaLabel={t('skills.componentsTitle')}
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
                  <Button variant="secondary" onClick={() => setRepoFilter([])}>
                    {t('skills.resetFilters')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <SkillInstallModal open={installOpen} onClose={() => setInstallOpen(false)} skillKeys={repoChecked} />
    </Page>
  );
}
