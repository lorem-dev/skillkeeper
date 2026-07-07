/**
 * Skills page. Two modes chosen by a Select:
 *   - Repositories: a tree of repo -> (group ->) skills; check skills to add.
 *   - Projects: a tree of project -> ("repo / group" ->) skills, pre-checked
 *     where installed, with a per-skill install-status badge; save applies the
 *     diff.
 * A search box fuzzy-filters the whole tree (matches keep their ancestors as
 * context); a footer summarizes the result and clears the search.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import {
  Page,
  Toolbar,
  Button,
  SearchField,
  Select,
  MultiCombobox,
  SearchSummary,
  TreeView,
  ChangeBadge,
  Icon,
} from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import type { AgentKind } from '@/services/bridge';
import { AgentSelect } from '@/entities/agent';
import {
  buildRepoTree,
  buildProjectTree,
  installedLeafIds,
  filterTree,
  collectBranchIds,
  rootIds,
  countLeaves,
} from '@/entities/skill';
import { SkillInstallModal } from '@/features/skillInstall';
import { SkillSaveModal } from '@/features/skillSave';
import './SkillsPage.scss';

type Mode = 'repositories' | 'projects';

/** Whether two agent lists hold the same set. */
function sameAgents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function SkillsPage() {
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const installs = useSkillkeeperStore((s) => s.skills);
  const t = useTranslator();

  const [mode, setMode] = useState<Mode>('projects');
  const [query, setQuery] = useState('');
  // Repo/project ids to include in the tree (empty = all).
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [repoChecked, setRepoChecked] = useState<string[]>([]);
  const [projectChecked, setProjectChecked] = useState<string[]>(() => installedLeafIds(installs));
  const [installOpen, setInstallOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  // Chosen agents per project (project id -> agents); seeded from the installed set.
  const [projectAgents, setProjectAgents] = useState<Record<string, AgentKind[]>>({});

  // The installed skills are the project-mode baseline (pre-checked). Re-seed the
  // project selection whenever that baseline changes (initial load, save, reload).
  const installedSet = useMemo(() => new Set(installedLeafIds(installs)), [installs]);
  useEffect(() => {
    setProjectChecked([...installedSet]);
  }, [installedSet]);

  // Agents each project currently has skills installed for (the baseline for the
  // "agents changed" indicator).
  const installedAgents = useMemo(() => {
    const map: Record<string, AgentKind[]> = {};
    for (const m of installs) {
      const pid = m.target.projectId;
      if (m.target.scope !== 'project' || pid === undefined) continue;
      const list = (map[pid] ??= []);
      if (!list.includes(m.target.agent)) list.push(m.target.agent);
    }
    return map;
  }, [installs]);

  useEffect(() => {
    setProjectAgents((prev) => {
      const next = { ...prev };
      for (const p of projects) if (next[p.id] === undefined) next[p.id] = installedAgents[p.id] ?? [];
      return next;
    });
  }, [projects, installedAgents]);

  // The filters narrow which repos/projects appear (empty = all).
  const shownRepos = useMemo(
    () => (repoFilter.length === 0 ? repositories : repositories.filter((r) => repoFilter.includes(r.id))),
    [repositories, repoFilter],
  );
  const shownProjects = useMemo(
    () => (projectFilter.length === 0 ? projects : projects.filter((p) => projectFilter.includes(p.id))),
    [projects, projectFilter],
  );

  const baseTree = useMemo(
    () =>
      mode === 'repositories'
        ? buildRepoTree(availableSkills, shownRepos)
        : buildProjectTree(availableSkills, shownRepos, shownProjects),
    [mode, availableSkills, shownRepos, shownProjects],
  );

  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // Project mode: tag each visible skill leaf with its install-status badge, and
  // give each project root an agent picker (with an "agents changed" marker).
  const decorated = useMemo(() => {
    if (mode !== 'projects') return shownTree;
    const checkedSet = new Set(projectChecked);
    const decorateLeaves = (nodes: readonly TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        if (node.children !== undefined && node.children.length > 0) {
          return { ...node, children: decorateLeaves(node.children) };
        }
        const wasInstalled = installedSet.has(node.id);
        const isChecked = checkedSet.has(node.id);
        let detail: ReactNode;
        if (wasInstalled && isChecked) detail = <ChangeBadge kind="present" label={t('skills.status.present')} />;
        else if (wasInstalled && !isChecked) detail = <ChangeBadge kind="remove" label={t('skills.status.remove')} />;
        else if (!wasInstalled && isChecked) detail = <ChangeBadge kind="add" label={t('skills.status.add')} />;
        else detail = undefined;
        return { ...node, detail };
      });
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
            onChange={(next) => setProjectAgents((prev) => ({ ...prev, [pid]: next }))}
            ariaLabel={t('skills.agentsLabel')}
          />
        </span>
      );
      return { ...root, trailing, children: decorateLeaves(root.children ?? []) };
    });
  }, [mode, shownTree, projectChecked, installedSet, projectAgents, installedAgents, t]);

  const searching = query.trim() !== '';
  const totalSkills = useMemo(() => countLeaves(baseTree), [baseTree]);
  const shownSkills = useMemo(() => countLeaves(decorated), [decorated]);
  const expandedIds = searching ? collectBranchIds(decorated) : rootIds(baseTree);

  const checkedIds = mode === 'repositories' ? repoChecked : projectChecked;
  const onCheckedChange = mode === 'repositories' ? setRepoChecked : setProjectChecked;

  // Project-mode pending change (drives the Save button + its notification).
  const pendingAdd = projectChecked.filter((id) => !installedSet.has(id)).length;
  const pendingRemove = useMemo(() => {
    const checkedSet = new Set(projectChecked);
    return [...installedSet].filter((id) => !checkedSet.has(id)).length;
  }, [projectChecked, installedSet]);

  function changeMode(next: Mode): void {
    setMode(next);
    setQuery('');
  }

  function onAdd(): void {
    setInstallOpen(true);
  }

  function onSave(): void {
    setSaveOpen(true);
  }

  const sourceOptions = [
    { value: 'repositories', label: t('skills.source.repositories') },
    { value: 'projects', label: t('skills.source.projects') },
  ];

  const repoOptions = repositories.map((r) => ({ value: r.id, label: r.name }));
  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }));
  const checkboxLevels = mode === 'repositories' ? [1, 2] : [1, 2, 3];

  const actions = (
    <>
      <SearchField
        className="sk-skills-search"
        placeholder={t('skills.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
        clearLabel={t('common.clear')}
      />
      {mode === 'repositories' ? (
        <Button variant="primary" disabled={repoChecked.length === 0} onClick={onAdd}>
          {t('skills.action.add')}
        </Button>
      ) : (
        <Button variant="primary" disabled={pendingAdd === 0 && pendingRemove === 0} onClick={onSave}>
          {t('skills.action.save')}
        </Button>
      )}
    </>
  );

  // Second toolbar row: display mode and the repo/project multi-select filters
  // that narrow which nodes the tree shows.
  const filters = (
    <div className="sk-skills-filters">
      <Select
        label={t('skills.source')}
        options={sourceOptions}
        value={mode}
        onChange={(v) => changeMode(v as Mode)}
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
      {mode === 'projects' && (
        <MultiCombobox
          label={t('skills.filterProjects')}
          options={projectOptions}
          value={projectFilter}
          onChange={setProjectFilter}
          placeholder={t('skills.filterProjectsPlaceholder')}
          emptyText={t('skills.filterProjectsEmpty')}
          ariaLabel={t('skills.filterProjects')}
        />
      )}
    </div>
  );

  return (
    <Page
      toolbar={
        <div className="sk-skills-header">
          <Toolbar title={t('nav.skills')} trailing={actions} />
          {filters}
        </div>
      }
    >
      {baseTree.length === 0 ? (
        <p className="sk-empty">
          {mode === 'repositories' ? t('skills.emptyRepositories') : t('skills.emptyProjects')}
        </p>
      ) : (
        <>
          <TreeView
            key={mode}
            className="sk-skills-tree"
            nodes={decorated}
            checkable
            checkboxLevels={checkboxLevels}
            checkedIds={checkedIds}
            onCheckedChange={onCheckedChange}
            defaultExpandedIds={expandedIds}
            ariaLabel={t('nav.skills')}
          />
          {searching && (
            <div className="sk-list-footer">
              <SearchSummary
                foundLabel={t.plural('skills.searchFound', shownSkills)}
                totalLabel={t.plural('skills.searchTotal', totalSkills)}
                showAllLabel={t('skills.showAll')}
                onShowAll={() => setQuery('')}
              />
            </div>
          )}
        </>
      )}
      <SkillInstallModal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        skillKeys={repoChecked}
      />
      <SkillSaveModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        checkedIds={projectChecked}
        projectAgents={projectAgents}
      />
    </Page>
  );
}
