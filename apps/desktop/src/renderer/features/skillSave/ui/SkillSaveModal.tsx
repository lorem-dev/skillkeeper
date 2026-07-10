/**
 * Projects-mode "Save" flow. Shows the pending changes -- at (skill, agent)
 * granularity, so changing a project's agents re-syncs even already-installed
 * skills -- in a table (Project | Repository | Skill | Action | Agents).
 * Also folds in MCP instance rows for the same reason (design spec "MCP
 * support" section 8, "Skills-change modal (agent changes)"): an agent added
 * to (or dropped from) a project's chosen set adds (or removes) that agent's
 * copy of every already-installed MCP instance, tagged with an "MCP" badge so
 * they read as distinct from skill rows. Confirm (double-confirm) applies
 * every project's skill plan, then its MCP plan (plus any freshly-prompted
 * params), in turn with a progress bar.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import type { AgentKind, McpBatch } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, ProgressBar, Table, Icon, Badge, TextField } from '@/shared/ui';
import type { TableColumn, TableRow } from '@/shared/ui';
import { AGENT_LABELS } from '@/domain';
import { buildProjectPlan } from '@/entities/skill';
import { buildInstallBatches } from '@/features/mcpInstall';
import { buildProjectMcpPlan } from '../lib/mcpPlan';
import './SkillSaveModal.scss';

/** Key for the per-row param-prompt draft values, unique across projects. */
function promptKey(projectId: string, rowKey: string): string {
  return `${projectId}::${rowKey}`;
}

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
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const mcpInstalls = useSkillkeeperStore((s) => s.mcpInstalls);
  const applyMcp = useSkillkeeperStore((s) => s.applyMcp);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

  const [confirming, setConfirming] = useState(false);
  // Draft values for install rows whose params are not yet known anywhere
  // (`needsParamPrompt`), keyed by `promptKey(projectId, row.key)`. Reset
  // whenever the modal (re)opens so a stale draft never survives to the next
  // review.
  const [mcpParamValues, setMcpParamValues] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    if (open) setMcpParamValues({});
  }, [open]);

  const repoName = useMemo(() => new Map(repositories.map((r) => [r.id, r.name] as const)), [repositories]);

  // A non-empty plan per project (skill+agent diff vs the installed state).
  const plans = useMemo(
    () =>
      projects
        .map((p) => ({ project: p, plan: buildProjectPlan(p.id, checkedIds, installs, projectAgents[p.id] ?? []) }))
        .filter(({ plan }) => plan.ops.length > 0),
    [projects, checkedIds, installs, projectAgents],
  );

  // Same idea for MCP instances: one row per (identity, action) per project,
  // grouping every agent's copy of the same installed instance-source.
  const mcpPlans = useMemo(
    () =>
      projects
        .map((p) => ({
          project: p,
          plan: buildProjectMcpPlan(mcpInstalls, p.id, projectAgents[p.id] ?? [], mcpPresets),
        }))
        .filter(({ plan }) => plan.rows.length > 0),
    [projects, mcpInstalls, projectAgents, mcpPresets],
  );

  const columns: TableColumn[] = [
    { key: 'project', header: t('skills.col.project'), width: '1fr' },
    { key: 'repo', header: t('skills.col.repository'), width: '1fr' },
    { key: 'skill', header: t('skills.col.skill'), width: '1.4fr' },
    { key: 'action', header: t('skills.col.action'), width: '7rem' },
    { key: 'agents', header: t('skills.col.agents'), width: '1fr' },
  ];

  // One row per (skill, agent, action): a skill may be installed for one agent
  // and removed for another when the agent set changes.
  const skillRows: TableRow[] = plans.flatMap(({ project, plan }) =>
    plan.ops.flatMap((op) => {
      const make = (ref: (typeof op.install)[number], action: 'install' | 'remove'): TableRow => {
        const skillLabel = ref.group !== undefined ? `${ref.group} / ${ref.name}` : ref.name;
        const skillKey = `${ref.repoId}::${ref.group ?? ''}::${ref.name}`;
        return {
          id: `${project.id}:${op.agent}:${action}:${skillKey}`,
          cells: [
            project.name,
            repoName.get(ref.repoId) ?? ref.repoId,
            skillLabel,
            <span key="a" className={`sk-save-modal__action sk-save-modal__action--${action}`}>
              {action === 'install' ? t('skills.change.install') : t('skills.change.remove')}
            </span>,
            AGENT_LABELS[op.agent],
          ],
        };
      };
      return [...op.install.map((r) => make(r, 'install')), ...op.remove.map((r) => make(r, 'remove'))];
    }),
  );

  // One row per (MCP instance-source, action) -- already grouped across
  // agents by `buildProjectMcpPlan` -- tagged with an "MCP" badge so they read
  // as distinct from skill rows in the same table.
  const mcpRows: TableRow[] = mcpPlans.flatMap(({ project, plan }) =>
    plan.rows.map((row) => ({
      id: `mcp:${project.id}:${row.key}`,
      cells: [
        project.name,
        row.preset?.origin === 'repo' ? (repoName.get(row.preset.repoId ?? '') ?? '') : '',
        <span key="s" className="sk-save-modal__mcplabel">
          <Icon name="mcp" size={14} />
          {row.label}
          <Badge tone="neutral">MCP</Badge>
        </span>,
        <span key="a" className={`sk-save-modal__action sk-save-modal__action--${row.action}`}>
          {row.action === 'install' ? t('skills.change.install') : t('skills.change.remove')}
        </span>,
        row.agents.map((a) => AGENT_LABELS[a]).join(', '),
      ],
    })),
  );

  const rows: TableRow[] = [...skillRows, ...mcpRows];

  // Install rows still missing their param values (no sibling instance to
  // copy from) -- Confirm stays disabled until every one is filled, per the
  // design spec: "do not silently install with blanks".
  const promptRows = mcpPlans.flatMap(({ project, plan }) =>
    plan.rows
      .filter((row) => row.action === 'install' && row.needsParamPrompt && row.preset !== undefined)
      .map((row) => ({ project, row, preset: row.preset! })),
  );
  const missingMcpParams = promptRows.some(({ project, row, preset }) => {
    const values = mcpParamValues[promptKey(project.id, row.key)] ?? {};
    return preset.params.some((p) => (values[p] ?? '').trim() === '');
  });

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
    // Apply each project's MCP plan, plus any install this review prompted
    // for (its preset's params were not yet known anywhere).
    for (const { project, plan } of mcpPlans) {
      const prompted: McpBatch[] = plan.rows
        .filter((row) => row.action === 'install' && row.needsParamPrompt && row.preset !== undefined)
        .flatMap((row) =>
          buildInstallBatches(row.preset!, row.agents, mcpParamValues[promptKey(project.id, row.key)] ?? {}),
        );
      const batches = [...plan.batches, ...prompted];
      if (batches.length === 0) continue;
      const result = await applyMcp({ projectId: project.id, projectPath: project.path, batches });
      if (!result.ok) {
        notify(result.error, 'error');
        return;
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
        {promptRows.length > 0 && (
          <div className="sk-save-modal__mcpprompt">
            <span className="sk-save-modal__mcpprompt-title">
              These MCP installs need parameters before they can be added:
            </span>
            {promptRows.map(({ project, row, preset }) => (
              <div key={`${project.id}::${row.key}`} className="sk-save-modal__mcpprompt-row">
                <span className="sk-save-modal__mcpprompt-label">
                  {project.name} / {row.label}
                </span>
                {preset.params.map((param) => {
                  const values = mcpParamValues[promptKey(project.id, row.key)] ?? {};
                  return (
                    <label key={param} className="sk-save-modal__mcpprompt-field">
                      <span>{param}</span>
                      <TextField
                        value={values[param] ?? ''}
                        disabled={busy}
                        onChange={(e) => {
                          const next = e.target.value;
                          setMcpParamValues((prev) => {
                            const k = promptKey(project.id, row.key);
                            return { ...prev, [k]: { ...prev[k], [param]: next } };
                          });
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        )}
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
          <Button
            variant="primary"
            disabled={rows.length === 0 || busy || missingMcpParams}
            onClick={() => void confirm()}
          >
            {confirming ? t('skills.save.confirm') : t('skills.action.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
