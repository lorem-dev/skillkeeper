/**
 * Projects-mode "Save" flow. Shows the pending diff (skills to install/remove
 * per project) in a table -- Project | Repository | Skill | Action | Agents --
 * with a per-project "agents changed" marker. Confirm (double-confirm) applies
 * every project's changes in turn with a progress bar.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import type { AgentKind, SkillRef } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, ProgressBar, Table, Icon } from '@/shared/ui';
import type { TableColumn, TableRow } from '@/shared/ui';
import { AGENT_LABELS } from '@/domain';
import { installedLeafIds, parseProjectSkillKey } from '@/entities/skill';
import './SkillSaveModal.scss';

export interface SkillSaveModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Project-mode checked keys (projectId::repoId::group::name). */
  readonly checkedIds: readonly string[];
  readonly projectAgents: Record<string, readonly AgentKind[]>;
}

interface Change {
  readonly key: string;
  readonly projectId: string;
  readonly ref: SkillRef;
  readonly action: 'install' | 'remove';
}

function sameAgents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function SkillSaveModal({ open, onClose, checkedIds, projectAgents }: SkillSaveModalProps) {
  const projects = useSkillkeeperStore((s) => s.projects);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const installs = useSkillkeeperStore((s) => s.skills);
  const applySkills = useSkillkeeperStore((s) => s.applySkills);
  const progress = useSkillkeeperStore((s) => s.skillApply);
  const t = useTranslator();

  const [confirming, setConfirming] = useState(false);

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as const)), [projects]);
  const repoName = useMemo(() => new Map(repositories.map((r) => [r.id, r.name] as const)), [repositories]);
  const installedAgents = useMemo(() => {
    const map: Record<string, AgentKind[]> = {};
    for (const m of installs) {
      const pid = m.target.projectId;
      if (m.target.scope !== 'project' || pid === undefined) continue;
      const list = (map[pid] ??= []);
      if (!list.includes(m.target.agent)) list.push(m.target.agent);
    }
    return map;
  }, [installs]);

  const changes = useMemo<Change[]>(() => {
    const installedSet = new Set(installedLeafIds(installs));
    const checkedSet = new Set(checkedIds);
    const out: Change[] = [];
    for (const key of checkedIds) {
      if (!installedSet.has(key)) {
        const p = parseProjectSkillKey(key);
        out.push({ key, projectId: p.projectId, ref: { repoId: p.repoId, group: p.group, name: p.name }, action: 'install' });
      }
    }
    for (const key of installedSet) {
      if (!checkedSet.has(key)) {
        const p = parseProjectSkillKey(key);
        out.push({ key, projectId: p.projectId, ref: { repoId: p.repoId, group: p.group, name: p.name }, action: 'remove' });
      }
    }
    return out;
  }, [checkedIds, installs]);

  const columns: TableColumn[] = [
    { key: 'project', header: t('skills.col.project'), width: '1fr' },
    { key: 'repo', header: t('skills.col.repository'), width: '1fr' },
    { key: 'skill', header: t('skills.col.skill'), width: '1.4fr' },
    { key: 'action', header: t('skills.col.action'), width: '7rem' },
    { key: 'agents', header: t('skills.col.agents'), width: '1fr' },
  ];

  const rows: TableRow[] = changes.map((c) => {
    const agents = projectAgents[c.projectId] ?? [];
    const changed = !sameAgents(agents, installedAgents[c.projectId] ?? []);
    const skillLabel = c.ref.group !== undefined ? `${c.ref.group} / ${c.ref.name}` : c.ref.name;
    const agentsCell: ReactNode = (
      <span className="sk-save-modal__agents">
        {agents.map((a) => AGENT_LABELS[a]).join(', ')}
        {changed && (
          <span className="sk-save-modal__agents-changed" aria-label={t('skills.agentsChanged')}>
            <Icon name="sync" size={13} />
          </span>
        )}
      </span>
    );
    return {
      id: c.key,
      cells: [
        projectName.get(c.projectId) ?? c.projectId,
        repoName.get(c.ref.repoId) ?? c.ref.repoId,
        skillLabel,
        <span key="a" className={`sk-save-modal__action sk-save-modal__action--${c.action}`}>
          {c.action === 'install' ? t('skills.change.install') : t('skills.change.remove')}
        </span>,
        agentsCell,
      ],
    };
  });

  const busy = progress !== null;

  async function confirm(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    // Group changes by project and apply each project's diff in turn.
    const byProject = new Map<string, { install: SkillRef[]; remove: SkillRef[] }>();
    for (const c of changes) {
      const entry = byProject.get(c.projectId) ?? { install: [], remove: [] };
      if (c.action === 'install') entry.install.push(c.ref);
      else entry.remove.push(c.ref);
      byProject.set(c.projectId, entry);
    }
    for (const [pid, diff] of byProject) {
      const proj = projects.find((p) => p.id === pid);
      if (proj === undefined) continue;
      const result = await applySkills({
        projectId: pid,
        projectPath: proj.path,
        agents: projectAgents[pid] ?? [],
        install: diff.install,
        remove: diff.remove,
      });
      if (!result.ok) return;
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
          <Button variant="primary" disabled={changes.length === 0 || busy} onClick={() => void confirm()}>
            {confirming ? t('skills.save.confirm') : t('skills.action.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
