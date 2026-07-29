/**
 * GlobalScopeCard: the user-wide install scope as a card, shown first on the
 * Projects page. Not a project -- there is no folder, so it carries no path, no
 * open-in-editor control, and no remove control. Counts arrive pre-formatted,
 * exactly as ProjectCard's do.
 */
import { Badge, Card, Tooltip } from '@/shared/ui';
import { ProjectIcon } from './ProjectIcon';
import './GlobalScopeCard.scss';

export interface GlobalScopeCardProps {
  /** Localized name of the scope. */
  readonly name: string;
  /** One line explaining what "global" means here. */
  readonly hint: string;
  /** Skills installed user-wide (pre-formatted, pluralized). */
  readonly skillCountLabel?: string;
  /** Tooltip for the skills badge. */
  readonly skillCountHint?: string;
  /** Agents with a user-wide install (pre-formatted, pluralized). */
  readonly agentsLabel?: string;
  /** Tooltip for the agents badge. */
  readonly agentsHint?: string;
}

export function GlobalScopeCard({
  name,
  hint,
  skillCountLabel,
  skillCountHint,
  agentsLabel,
  agentsHint,
}: GlobalScopeCardProps) {
  return (
    <Card className="sk-global-scope-card">
      <ProjectIcon global name="" size={18} className="sk-global-scope-card__leading-icon" />
      <div className="sk-global-scope-card__main">
        <span className="sk-global-scope-card__name">{name}</span>
        <span className="sk-global-scope-card__hint">{hint}</span>
        <span className="sk-global-scope-card__badges">
          {skillCountLabel !== undefined && (
            <Tooltip content={skillCountHint ?? ''}>
              <Badge tone="neutral">{skillCountLabel}</Badge>
            </Tooltip>
          )}
          {agentsLabel !== undefined && (
            <Tooltip content={agentsHint ?? ''}>
              <Badge tone="neutral">{agentsLabel}</Badge>
            </Tooltip>
          )}
        </span>
      </div>
    </Card>
  );
}
