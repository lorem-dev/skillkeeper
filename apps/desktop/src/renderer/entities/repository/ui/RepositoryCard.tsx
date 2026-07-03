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
        <span className="sk-repo-card__name-row">
          <span className="sk-repo-card__name">{repository.name}</span>
          {hasUpdate && <span className="sk-repo-card__update-dot" title={updateLabel} />}
        </span>
        <span className="sk-repo-card__url">{repository.url}</span>
      </div>
      <div className="sk-repo-card__actions">
        <Button
          variant="secondary"
          className="sk-repo-card__icon-btn"
          onClick={onSync}
          disabled={busy}
          aria-label={syncLabel}
        >
          {busy ? <Spinner labelHidden /> : <Icon name="sync" />}
        </Button>
        <Button
          variant="secondary"
          className="sk-repo-card__icon-btn"
          onClick={onEdit}
          aria-label={editLabel}
        >
          <Icon name="edit" />
        </Button>
      </div>
    </Card>
  );
}
