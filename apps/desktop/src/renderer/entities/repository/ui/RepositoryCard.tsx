import type { Repository } from '@/services/bridge';
import { Card, Button, Icon, Spinner } from '@/shared/ui';
import './RepositoryCard.scss';

export interface RepositoryCardProps {
  readonly repository: Repository;
  readonly phase: 'idle' | 'cloning' | 'syncing';
  readonly hasUpdate: boolean;
  /** Translated labels. */
  readonly syncLabel: string;
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
  editLabel,
  updateLabel,
  onSync,
  onEdit,
}: RepositoryCardProps) {
  const busy = phase !== 'idle';
  return (
    <Card className="sk-repo-card">
      <div className="sk-repo-card__main">
        <span className="sk-repo-card__name">{repository.name}</span>
        <span className="sk-repo-card__url">{repository.url}</span>
      </div>
      <div className="sk-repo-card__actions">
        <span className="sk-repo-card__status" aria-hidden={!busy && !hasUpdate}>
          {busy ? (
            <div className="sk-repo-card__spinner-box">
              <Spinner />
            </div>
          ) : hasUpdate ? (
            <span className="sk-repo-card__update-dot" title={updateLabel} />
          ) : null}
        </span>
        <Button variant="secondary" onClick={onSync} disabled={busy}>
          {syncLabel}
        </Button>
        <Button variant="plain" onClick={onEdit} aria-label={editLabel}>
          <Icon name="edit" />
        </Button>
      </div>
    </Card>
  );
}
