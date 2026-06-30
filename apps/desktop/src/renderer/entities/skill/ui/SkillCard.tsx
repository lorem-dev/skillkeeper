import type { InstalledSkillView } from '../lib/aggregateInstalls';
import { Card, Badge } from '@/shared/ui';
import './SkillCard.scss';

export interface SkillCardProps {
  readonly skill: InstalledSkillView;
  /** Already-translated version label, or null when no version. */
  readonly versionLabel: string | null;
  /** Already-translated agent labels, in display order. */
  readonly agentLabels: string[];
  readonly onOpen: () => void;
}

export function SkillCard({ skill, versionLabel, agentLabels, onOpen }: SkillCardProps) {
  return (
    <Card className="sk-skill-card">
      <button type="button" className="sk-skill-card__btn" onClick={onOpen}>
        <span className="sk-skill-card__title">
          {skill.group !== undefined ? `${skill.group}/${skill.name}` : skill.name}
          {versionLabel !== null && <Badge tone="neutral">{versionLabel}</Badge>}
        </span>
        <span className="sk-skill-card__agents">
          {agentLabels.map((a) => (
            <Badge key={a} tone="accent">{a}</Badge>
          ))}
        </span>
      </button>
    </Card>
  );
}
