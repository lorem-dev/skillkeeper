/**
 * Projects-mode "Save" flow. Shows the pending changes -- at (skill, agent)
 * granularity, so changing a project's agents re-syncs even already-installed
 * skills -- in a table (Project | Repository | Skill | Action | Agents).
 * Confirm (double-confirm) applies every project's plan in turn with a
 * progress bar.
 */
import { useMemo, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import type { AgentKind } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, ProgressBar, Table } from '@/shared/ui';
import type { TableColumn, TableRow } from '@/shared/ui';
import { AGENT_LABELS } from '@/domain';
import { buildProjectPlan } from '@/entities/skill';
import './SkillSaveModal.scss';

export interface SkillSaveModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Project-mode checked keys (projectId::repoId::group::name). */
  readonly checkedIds: readonly string[];
  readonly projectAgents: Record<string, readonly AgentKind[]>;
}

export function SkillSaveModal({ open, onClose, checkedIds, projectAgents }: SkillSaveModalProps) {
  const projects = useSkillkeeperStore((s) => s.projects);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const installs = useSkillkeeperStore((s) => s.skills);
  const applySkills = useSkillkeeperStore((s) => s.applySkills);
  const progress = useSkillkeeperStore((s) => s.skillApply);
  const t = useTranslator();

  const [confirming, setConfirming] = useState(false);

  const repoName = useMemo(() => new Map(repositories.map((r) => [r.id, r.name] as const)), [repositories]);

  // A non-empty plan per project (skill+agent diff vs the installed state).
  const plans = useMemo(
    () =>
      projects
        .map((p) => ({ project: p, plan: buildProjectPlan(p.id, checkedIds, installs, projectAgents[p.id] ?? []) }))
        .filter(({ plan }) => plan.ops.length > 0),
    [projects, checkedIds, installs, projectAgents],
  );

  const columns: TableColumn[] = [
    { key: 'project', header: t('skills.col.project'), width: '1fr' },
    { key: 'repo', header: t('skills.col.repository'), width: '1fr' },
    { key: 'skill', header: t('skills.col.skill'), width: '1.4fr' },
    { key: 'action', header: t('skills.col.action'), width: '7rem' },
    { key: 'agents', header: t('skills.col.agents'), width: '1fr' },
  ];

  const rows: TableRow[] = plans.flatMap(({ project, plan }) =>
    plan.rows.map((r) => {
      const skillLabel = r.ref.group !== undefined ? `${r.ref.group} / ${r.ref.name}` : r.ref.name;
      return {
        id: `${project.id}:${r.action}:${r.skillKey}`,
        cells: [
          project.name,
          repoName.get(r.ref.repoId) ?? r.ref.repoId,
          skillLabel,
          <span key="a" className={`sk-save-modal__action sk-save-modal__action--${r.action}`}>
            {r.action === 'install' ? t('skills.change.install') : t('skills.change.remove')}
          </span>,
          r.agents.map((a) => AGENT_LABELS[a]).join(', '),
        ],
      };
    }),
  );

  const busy = progress !== null;

  async function confirm(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    // Apply each project's plan; one applySkills call per agent op.
    for (const { project, plan } of plans) {
      for (const op of plan.ops) {
        const result = await applySkills({
          projectId: project.id,
          projectPath: project.path,
          agents: [op.agent],
          install: op.install,
          remove: op.remove,
        });
        if (!result.ok) return;
      }
    }
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t('skills.save.title')}
      className="sk-save-modal"
    >
      <div className="sk-save-modal__body">
        <Table
          columns={columns}
          rows={rows}
          stickyHeader
          maxBodyHeight="46vh"
          ariaLabel={t('skills.save.title')}
          emptyText={t('skills.save.empty')}
        />
        {busy && progress !== null && (
          <div className="sk-save-modal__progress">
            <ProgressBar
              value={progress.total > 0 ? progress.done / progress.total : undefined}
              label={t('skills.install.installing')}
            />
            <span className="sk-save-modal__progress-label">{progress.label}</span>
          </div>
        )}
        <div className="sk-save-modal__actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="primary" disabled={rows.length === 0 || busy} onClick={() => void confirm()}>
            {confirming ? t('skills.save.confirm') : t('skills.action.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
