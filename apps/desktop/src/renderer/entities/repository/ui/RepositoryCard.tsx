import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Repository } from '@/services/bridge';
import { Badge, Card, Button, Icon, Skeleton, Spinner, Tooltip } from '@/shared/ui';
import { transitionFast } from '@/shared/lib';
import './RepositoryCard.scss';

export interface RepositoryCardProps {
  readonly repository: Repository;
  readonly phase: 'idle' | 'cloning' | 'syncing';
  readonly hasUpdate: boolean;
  /** When set, the repo shows a red error dot instead of the blue update dot. */
  readonly error?: string;
  /** Translated labels. */
  readonly syncLabel: string;
  /** Sync tooltip while cloning/syncing (e.g. "Syncing"). */
  readonly syncingLabel: string;
  readonly editLabel: string;
  readonly updateLabel: string;
  readonly errorLabel: string;
  /** Tooltip for the remote URL (e.g. "Copy"). */
  readonly urlCopyLabel?: string;
  /** Called when the remote URL is clicked (copies the URL). */
  readonly onUrlClick?: () => void;
  /** Current branch name (full); shows a gray badge (truncated) when set. */
  readonly branch?: string | null;
  /** Tooltip for the branch badge (e.g. "Copy"). */
  readonly branchCopyLabel?: string;
  /** Called when the branch badge is clicked (copies the full branch name). */
  readonly onBranchClick?: () => void;
  /** Pre-formatted, pluralized skill count (e.g. "3 skills"); shows a blue badge when set. */
  readonly skillCountLabel?: string;
  /** Branch/skill info not fetched yet (e.g. right after add): show skeletons in
   * the badges row so its height is reserved and never jumps. */
  readonly infoPending?: boolean;
  readonly onSync: () => void;
  readonly onEdit: () => void;
  readonly onErrorClick: () => void;
}

/** Longest branch name shown on the badge before it is truncated with "...". */
const BRANCH_MAX = 25;
/** Hard cap on the remote URL string length (CSS also ellipsizes to the card). */
const URL_MAX = 80;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function RepositoryCard({
  repository,
  phase,
  hasUpdate,
  error,
  syncLabel,
  syncingLabel,
  editLabel,
  updateLabel,
  errorLabel,
  urlCopyLabel,
  onUrlClick,
  branch,
  branchCopyLabel,
  onBranchClick,
  skillCountLabel,
  infoPending,
  onSync,
  onEdit,
  onErrorClick,
}: RepositoryCardProps) {
  const busy = phase !== 'idle';

  // Name-row status indicator, in priority order:
  //   1. cloning/syncing in progress -> blue pulsing "processing" dot
  //   2. a recorded error            -> red clickable dot
  //   3. an update is available      -> blue pulsing dot
  // `indicatorKey` keys the AnimatePresence child so the dot fades/scales when
  // it appears, disappears, or switches kind.
  let indicatorKey: 'busy' | 'error' | 'update' | null = null;
  let indicator: ReactNode = null;
  if (busy) {
    indicatorKey = 'busy';
    indicator = (
      <Tooltip content={syncingLabel}>
        <span className="sk-repo-card__update-dot sk-repo-card__update-dot--pulse" />
      </Tooltip>
    );
  } else if (error !== undefined) {
    indicatorKey = 'error';
    indicator = (
      <Tooltip content={errorLabel}>
        <button
          type="button"
          className="sk-repo-card__error-dot"
          aria-label={errorLabel}
          onClick={onErrorClick}
        />
      </Tooltip>
    );
  } else if (hasUpdate) {
    indicatorKey = 'update';
    indicator = (
      <Tooltip content={updateLabel}>
        <span className="sk-repo-card__update-dot" />
      </Tooltip>
    );
  }

  return (
    <Card className="sk-repo-card">
      <div className="sk-repo-card__main">
        <span className="sk-repo-card__name-row">
          <span className="sk-repo-card__name">{repository.name}</span>
          <AnimatePresence mode="wait" initial={false}>
            {indicatorKey !== null && (
              <motion.span
                key={indicatorKey}
                className="sk-repo-card__indicator"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={transitionFast}
              >
                {indicator}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        {onUrlClick !== undefined ? (
          <Tooltip content={urlCopyLabel ?? ''} className="sk-repo-card__url-tip">
            <button
              type="button"
              className="sk-repo-card__url sk-repo-card__url--button"
              onClick={onUrlClick}
              aria-label={urlCopyLabel}
            >
              {truncate(repository.url, URL_MAX)}
            </button>
          </Tooltip>
        ) : (
          <span className="sk-repo-card__url">{truncate(repository.url, URL_MAX)}</span>
        )}
        {/* Always rendered with a reserved height so the card never jumps: skeleton
            placeholders while info loads, then the real branch + skill badges. */}
        <span className="sk-repo-card__badges">
          {infoPending === true ? (
            <>
              <Skeleton width={92} height={20} radius="var(--sk-radius-pill)" />
              <Skeleton width={56} height={20} radius="var(--sk-radius-pill)" />
            </>
          ) : (
            <>
              {branch != null && branch !== '' && (
                <Tooltip content={branchCopyLabel ?? ''}>
                  <button
                    type="button"
                    className="sk-repo-card__branch"
                    onClick={onBranchClick}
                    aria-label={branchCopyLabel}
                  >
                    <Badge tone="neutral">{truncate(branch, BRANCH_MAX)}</Badge>
                  </button>
                </Tooltip>
              )}
              {skillCountLabel !== undefined && <Badge tone="accent">{skillCountLabel}</Badge>}
            </>
          )}
        </span>
      </div>
      <div className="sk-repo-card__actions">
        <Tooltip content={busy ? syncingLabel : syncLabel}>
          <Button
            variant="secondary"
            className="sk-repo-card__icon-btn"
            onClick={() => {
              if (!busy) onSync();
            }}
            aria-disabled={busy}
            aria-label={syncLabel}
          >
            {busy ? <Spinner labelHidden /> : <Icon name="sync" />}
          </Button>
        </Tooltip>
        <Tooltip content={editLabel}>
          <Button
            variant="secondary"
            className="sk-repo-card__icon-btn"
            onClick={onEdit}
            aria-label={editLabel}
          >
            <Icon name="edit" />
          </Button>
        </Tooltip>
      </div>
    </Card>
  );
}
