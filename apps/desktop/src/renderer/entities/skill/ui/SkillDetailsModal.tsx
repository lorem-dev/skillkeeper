import type { InstalledSkillView } from '../lib/aggregateInstalls';
import { Modal, Badge, Button, Tooltip } from '@/shared/ui';
import './SkillDetailsModal.scss';

export interface SkillDetailsModalProps {
  readonly skill: InstalledSkillView | null;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Pre-formatted, already-translated lines. */
  readonly title: string;
  readonly filesLabel: string;
  readonly hooksLabel: string;
  readonly installedAtLabel: string;
  readonly destinationLabel: string;
  readonly agentLabels: string[];
  readonly verifyLabel: string;
  readonly updateLabel: string;
  readonly comingSoonLabel: string;
}

export function SkillDetailsModal(props: SkillDetailsModalProps) {
  const { skill, open, onClose, title } = props;
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {skill !== null && (
        <div className="sk-skill-details">
          <div className="sk-skill-details__name">
            {skill.group !== undefined ? `${skill.group}/${skill.name}` : skill.name}
          </div>
          <div className="sk-skill-details__agents">
            {props.agentLabels.map((a) => (
              <Badge key={a} tone="accent">{a}</Badge>
            ))}
          </div>
          <ul className="sk-skill-details__meta">
            <li>{props.filesLabel}</li>
            <li>{props.hooksLabel}</li>
            <li>{props.installedAtLabel}</li>
            <li>{props.destinationLabel}: {skill.destinationRoot}</li>
          </ul>
          <div className="sk-skill-details__actions">
            <Tooltip content={props.comingSoonLabel}>
              <Button variant="secondary" disabled>{props.verifyLabel}</Button>
            </Tooltip>
            <Tooltip content={props.comingSoonLabel}>
              <Button variant="primary" disabled>{props.updateLabel}</Button>
            </Tooltip>
          </div>
        </div>
      )}
    </Modal>
  );
}
