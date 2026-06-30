import type { Repository } from '@/services/bridge';
import { Card, Badge } from '@/shared/ui';
import './RepositoryCard.scss';

export interface RepositoryCardProps {
  readonly repository: Repository;
  /** Already-translated "LFS" label. */
  readonly lfsLabel: string;
  /** Already-translated, fully-formatted last-fetched line. */
  readonly lastFetchedLabel: string;
}

export function RepositoryCard({ repository, lfsLabel, lastFetchedLabel }: RepositoryCardProps) {
  return (
    <Card className="sk-repo-card">
      <div className="sk-repo-card__head">
        <span className="sk-repo-card__name">{repository.name}</span>
        <span className="sk-repo-card__badges">
          <Badge tone="accent">{repository.kind}</Badge>
          <Badge tone="neutral">{repository.transport}</Badge>
          {repository.lfs && <Badge tone="neutral">{lfsLabel}</Badge>}
        </span>
      </div>
      <div className="sk-repo-card__url">{repository.url}</div>
      <div className="sk-repo-card__meta">
        <span className="sk-repo-card__path">{repository.localPath}</span>
        <span className="sk-repo-card__fetched">{lastFetchedLabel}</span>
      </div>
    </Card>
  );
}
