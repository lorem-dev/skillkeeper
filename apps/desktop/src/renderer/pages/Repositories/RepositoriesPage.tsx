/**
 * Repositories page. Displays all installed repositories with refresh and
 * add options in the toolbar.
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { RepositoryCard } from '@/entities/repository';
import { RepoAddButton } from '@/features/repoAdd';
import { RepoEditModal } from '@/features/repoEdit';
import type { Repository } from '@/services/bridge';
import { Page, Toolbar, Button, ExpandingSearch, SearchSummary, Tooltip, Icon } from '@/shared/ui';
import { fuzzyFilter, cardStagger, fade, cx, useAnimationsEnabled } from '@/shared/lib';
import './RepositoriesPage.scss';

/** How long the transient focus ring stays on a card scrolled into view by
 *  `repoFocus` (e.g. from an MCP preset's source-repo badge). */
const FOCUS_HIGHLIGHT_MS = 1600;

/** Minimum time the Refresh button stays in its loading state, so a refresh
 *  that finishes quickly still reads as a deliberate action, not a flicker. */
const REFRESH_MIN_MS = 1000;

export function RepositoriesPage() {
  const animate = useAnimationsEnabled();
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const repoStatus = useSkillkeeperStore((s) => s.repoStatus);
  const repoInfo = useSkillkeeperStore((s) => s.repoInfo);
  const syncRepository = useSkillkeeperStore((s) => s.syncRepository);
  const refreshRepoUpdates = useSkillkeeperStore((s) => s.refreshRepoUpdates);
  const refreshRepoInfo = useSkillkeeperStore((s) => s.refreshRepoInfo);
  const showRepoError = useSkillkeeperStore((s) => s.showRepoError);
  const goToSkills = useSkillkeeperStore((s) => s.goToSkills);
  const goToMcp = useSkillkeeperStore((s) => s.goToMcp);
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const notify = useSkillkeeperStore((s) => s.notify);
  const repoFocus = useSkillkeeperStore((s) => s.repoFocus);
  const t = useTranslator();
  const [editing, setEditing] = useState<Repository | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightRepoId, setHighlightRepoId] = useState<string | null>(null);

  function copyBranch(branch: string): void {
    void navigator.clipboard.writeText(branch);
    // Store the key (not the translated text) so the log follows the language.
    notify({ key: 'repositories.branchCopied' }, 'info');
  }

  function copyRemote(url: string): void {
    void navigator.clipboard.writeText(url);
    notify({ key: 'repositories.remoteCopied' }, 'info');
  }

  // Branch/skill info is local and cheap -- refresh it on mount. The network
  // update check (refreshRepoUpdates) is driven by the Refresh button and the
  // startup/scheduled checks (useUpdateSchedule), not on every navigation.
  useEffect(() => {
    void refreshRepoInfo();
  }, [refreshRepoInfo]);

  // A "focus this repository" request (App switched here for it): clear any
  // active search first so the target card is guaranteed to be in the
  // rendered (filtered) list -- a no-op re-render when the query is already
  // empty, since React bails out on an unchanged string.
  useEffect(() => {
    if (repoFocus !== null) setQuery('');
  }, [repoFocus]);

  // Scroll the focused card into view and apply a transient highlight ring.
  // Keyed on `query` (not the `filtered` array, which is a fresh reference on
  // every render) so this only re-runs once the search-clearing effect above
  // has actually committed the empty query, guaranteeing the card is present.
  useEffect(() => {
    if (repoFocus === null) return undefined;
    const el = document.querySelector<HTMLElement>(`[data-repo-id="${CSS.escape(repoFocus.repoId)}"]`);
    if (el === null) return undefined;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightRepoId(repoFocus.repoId);
    const timer = setTimeout(() => setHighlightRepoId(null), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [repoFocus, query]);

  // Fuzzy search by name, remote URL, and tracked branch. The field only
  // appears once there are at least two cards to sift through.
  const searching = query.trim() !== '';
  const filtered = fuzzyFilter(repositories, query, (r) => [
    r.name,
    r.url,
    repoInfo[r.id]?.branch ?? '',
  ]);

  // Repositories that contribute at least one MCP preset -- gates each card's
  // "go to MCP" button (cheap to rebuild; the preset list is small).
  const reposWithMcp = new Set(
    mcpPresets.map((p) => p.repoId).filter((id): id is string => id !== undefined),
  );

  const trailing = (
    <>
      {repositories.length >= 2 && (
        <ExpandingSearch
          glass
          label={t('common.search')}
          placeholder={t('common.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />
      )}
      <Tooltip content={t('common.refresh')}>
        <Button
          variant="secondary"
          glass
          aria-label={t('common.refresh')}
          className="sk-refresh-btn"
          loading={refreshing}
          onClick={() => {
            // Loading (and non-clickable) until every queued update-check task
            // and the info refresh have fully settled -- but for at least
            // REFRESH_MIN_MS, so a fast refresh does not just flash.
            setRefreshing(true);
            const minDelay = new Promise((resolve) => setTimeout(resolve, REFRESH_MIN_MS));
            void Promise.all([refreshRepoUpdates(), refreshRepoInfo(), minDelay]).finally(() =>
              setRefreshing(false),
            );
          }}
        >
          <Icon name="sync" size={16} />
        </Button>
      </Tooltip>
    </>
  );

  return (
    <Page
      toolbar={<Toolbar title={t('nav.repositories')} trailing={trailing} />}
      dock={<RepoAddButton />}
    >
      {repositories.length === 0 ? (
        <p className="sk-empty">{t('repositories.empty')}</p>
      ) : (
        <>
        <div className="sk-repo-list">
          <AnimatePresence mode="popLayout" initial={animate}>
          {filtered.map((r, i) => (
            <motion.div
              key={r.id}
              layout
              custom={i}
              variants={cardStagger}
              initial="initial"
              animate="animate"
              exit="exit"
              data-repo-id={r.id}
              className={cx('sk-repo-card-anchor', highlightRepoId === r.id && 'sk-repo-card-anchor--highlight')}
            >
            <RepositoryCard
              repository={r}
              phase={repoStatus[r.id]?.phase ?? 'idle'}
              hasUpdate={repoStatus[r.id]?.hasUpdate ?? false}
              error={repoStatus[r.id]?.error}
              syncLabel={t('repositories.sync')}
              syncingLabel={t('repositories.syncing')}
              editLabel={t('repositories.edit')}
              updateLabel={t('repositories.hasUpdate')}
              errorLabel={t('repositories.viewError')}
              urlCopyLabel={t('repositories.copyRemote')}
              onUrlClick={() => copyRemote(r.url)}
              branch={repoInfo[r.id]?.branch}
              branchCopyLabel={t('repositories.copyBranch')}
              onBranchClick={() => {
                const branch = repoInfo[r.id]?.branch;
                if (branch != null && branch !== '') copyBranch(branch);
              }}
              skillCountLabel={
                repoInfo[r.id] !== undefined
                  ? t.plural('repositories.skillCount', repoInfo[r.id]!.skillCount)
                  : undefined
              }
              infoPending={repoInfo[r.id] === undefined}
              skillsLabel={t('common.goToSkills')}
              mcpLabel={t('common.goToMcp')}
              onSync={() => void syncRepository(r.id)}
              onEdit={() => setEditing(r)}
              onGoToSkills={
                (repoInfo[r.id]?.skillCount ?? 0) > 0
                  ? () => goToSkills({ mode: 'repositories', repoFilter: [r.id] }, false)
                  : undefined
              }
              onGoToMcp={reposWithMcp.has(r.id) ? () => goToMcp(r.id) : undefined}
              onErrorClick={() => showRepoError(r.id)}
            />
            </motion.div>
          ))}
          </AnimatePresence>
        </div>
        <AnimatePresence>
          {searching && (
            <motion.div
              key="footer"
              className="sk-list-footer"
              variants={fade}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <SearchSummary
                foundLabel={t.plural('repositories.searchFound', filtered.length)}
                totalLabel={t.plural('repositories.searchTotal', repositories.length)}
                showAllLabel={t('repositories.showAll')}
                onShowAll={() => setQuery('')}
              />
            </motion.div>
          )}
        </AnimatePresence>
        </>
      )}
      <RepoEditModal repository={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
