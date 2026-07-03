import type { Repository } from '@/services/bridge';
import { Card, Button, Icon, Spinner, Tooltip } from '@/shared/ui';
import './RepositoryCard.scss';

export interface RepositoryCardProps {
  readonly repository: Repository;
  readonly phase: 'idle' | 'cloning' | 'syncing';
  readonly hasUpdate: boolean;
  /** Translated labels. */
  readonly syncLabel: string;
  /** Sync tooltip while cloning/syncing (e.g. "Syncing"). */
  readonly syncingLabel: string;
  readonly editLabel: string;
  readonly updateLabel: string;
  readonly onSync: () => void;
  readonly onEdit: () => void;
}

export function RepositoryCard({
  repository,
  phase,
  hasUpdate,
  syncLabel,
  syncingLabel,
  editLabel,
  updateLabel,
  onSync,
  onEdit,
}: RepositoryCardProps) {
  const busy = phase !== 'idle';
  return (
    <Card className="sk-repo-card">
      <div className="sk-repo-card__main">
        <span className="sk-repo-card__name-row">
          <span className="sk-repo-card__name">{repository.name}</span>
          {hasUpdate && (
            <Tooltip content={updateLabel}>
              <span className="sk-repo-card__update-dot" />
            </Tooltip>
          )}
        </span>
        <span className="sk-repo-card__url">{repository.url}</span>
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
