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
  SearchSummary,
  TreeView,
  ChangeBadge,
  Tooltip,
} from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import {
  buildRepoTree,
  buildProjectTree,
  installedLeafIds,
  filterTree,
  collectBranchIds,
  rootIds,
  countLeaves,
} from './lib/skillTree';
import './SkillsPage.scss';

type Mode = 'repositories' | 'projects';

export function SkillsPage() {
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const installs = useSkillkeeperStore((s) => s.skills);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

  const [mode, setMode] = useState<Mode>('repositories');
  const [query, setQuery] = useState('');
  const [selectOpen, setSelectOpen] = useState(false);
  const [tipSuppressed, setTipSuppressed] = useState(false);
  const [repoChecked, setRepoChecked] = useState<string[]>([]);
  const [projectChecked, setProjectChecked] = useState<string[]>(() => installedLeafIds(installs));

  // The installed skills are the project-mode baseline (pre-checked). Re-seed the
  // project selection whenever that baseline changes (initial load, save, reload).
  const installedSet = useMemo(() => new Set(installedLeafIds(installs)), [installs]);
  useEffect(() => {
    setProjectChecked([...installedSet]);
  }, [installedSet]);

  const baseTree = useMemo(
    () =>
      mode === 'repositories'
        ? buildRepoTree(availableSkills, repositories)
        : buildProjectTree(availableSkills, repositories, projects),
    [mode, availableSkills, repositories, projects],
  );

  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // Project mode: tag each visible skill leaf with its install-status badge.
  const decorated = useMemo(() => {
    if (mode !== 'projects') return shownTree;
    const checkedSet = new Set(projectChecked);
    const decorate = (nodes: readonly TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        if (node.children !== undefined && node.children.length > 0) {
          return { ...node, children: decorate(node.children) };
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
    return decorate(shownTree);
  }, [mode, shownTree, projectChecked, installedSet, t]);

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
    // Execution (install into a chosen target) is a follow-up; surface the intent.
    notify(t('skills.installPending', { count: String(repoChecked.length) }), 'info');
  }

  function onSave(): void {
    notify(
      t('skills.savePending', { add: String(pendingAdd), remove: String(pendingRemove) }),
      'info',
    );
  }

  const sourceOptions = [
    { value: 'repositories', label: t('skills.source.repositories') },
    { value: 'projects', label: t('skills.source.projects') },
  ];

  const trailing = (
    <>
      <SearchField
        className="sk-skills-search"
        placeholder={t('skills.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
        clearLabel={t('common.clear')}
      />
      {/* Suppress the tooltip while the dropdown is open, and after a selection
          (focus returns to the trigger) until the pointer/focus leaves and
          comes back -- so picking an option closes the tooltip too. */}
      <span
        className="sk-skills-source"
        onMouseEnter={() => setTipSuppressed(false)}
        onBlurCapture={() => setTipSuppressed(false)}
      >
        <Tooltip content={t('skills.source')} disabled={selectOpen || tipSuppressed}>
          <Select
            ariaLabel={t('skills.source')}
            options={sourceOptions}
            value={mode}
            onChange={(v) => {
              setTipSuppressed(true);
              changeMode(v as Mode);
            }}
            onOpenChange={setSelectOpen}
          />
        </Tooltip>
      </span>
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

  return (
    <Page toolbar={<Toolbar title={t('nav.skills')} trailing={trailing} />}>
      {baseTree.length === 0 ? (
        <p className="sk-empty">
          {mode === 'repositories' ? t('skills.emptyRepositories') : t('skills.emptyProjects')}
        </p>
      ) : (
        <>
          <TreeView
            key={mode}
            nodes={decorated}
            checkable
            checkboxLevels={[1, 2]}
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
    </Page>
  );
}
