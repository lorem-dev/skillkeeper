/**
 * MCP install modal: installs one preset (manual or repo-discovered) into a
 * project under one or more agents. Mirrors `SkillInstallModal`/
 * `McpEditModal` for structure -- see design spec "MCP support" section 8
 * ("Install modal") and section 5 ("Install (per selected agent target)").
 *
 * The update flow (design spec section 5 "Update (per instance)": seed known
 * params, prompt only missing ones, abort on close without all values) reuses
 * this modal via the optional `initialValues` prop -- known params are
 * pre-filled but still editable, missing ones start empty, and every param
 * stays required, so closing without a value for a newly-required param
 * simply never calls `onClose` via a successful install (nothing is applied
 * until Confirm succeeds). Wiring an update instance's `identity`/`agent`
 * (single target, not a fresh multi-agent batch) into `updateMcp` is left to
 * the consuming task (C6/C7): this modal only ever builds fresh-install
 * batches via `buildInstallBatches`.
 */
import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import type { McpPreset } from '@/app/store';
import type { AgentKind } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, TextField, Checkbox, Tooltip, Alert } from '@/shared/ui';
import { ProjectSelect } from '@/entities/project';
import { ALL_AGENTS, AGENT_LABELS } from '@/domain';
import { supportsTransport } from '../lib/supportsTransport';
import { buildInstallBatches } from '../lib/buildBatches';
import './McpInstallModal.scss';

export interface McpInstallModalProps {
  readonly open: boolean;
  /** The preset being installed (manual or repo-discovered). */
  readonly preset: McpPreset;
  /** Pre-selects the project when opened from that project's own context
   *  (e.g. its skills tree); left unset opens with no project chosen so the
   *  user picks one from the `ProjectSelect`. */
  readonly preselectedProjectId?: string;
  /** Seeds already-known parameter values (update flow); a fresh install
   *  passes nothing and every param starts empty. */
  readonly initialValues?: Record<string, string>;
  readonly onClose: () => void;
}

export function McpInstallModal({
  open,
  preset,
  preselectedProjectId,
  initialValues,
  onClose,
}: McpInstallModalProps) {
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const applyMcp = useSkillkeeperStore((s) => s.applyMcp);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Reset the form every time the modal opens -- mirrors SkillInstallModal's
  // reset-on-open effect. Deliberately keyed only on `open` (not on
  // `preset`/`initialValues`, whose identity a caller may not keep stable
  // across renders): a mounted, still-open modal is never expected to swap
  // its preset out from under the user mid-edit.
  useEffect(() => {
    if (!open) return;
    setProjectId(preselectedProjectId ?? '');
    setAgents([]);
    const seeded: Record<string, string> = {};
    for (const param of preset.params) seeded[param] = initialValues?.[param] ?? '';
    setValues(seeded);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const project = projects.find((p) => p.id === projectId);
  const projectPath = project?.path ?? '';

  /** Reason text for a disabled agent checkbox, or undefined when selectable. */
  function disabledReason(agent: AgentKind): string | undefined {
    if (supportsTransport(agent, preset.def.type)) return undefined;
    return t('mcp.transportUnsupported', {
      agent: AGENT_LABELS[agent],
      transport: t(`mcp.protocol.${preset.def.type}`),
    });
  }

  function toggleAgent(agent: AgentKind): void {
    if (disabledReason(agent) !== undefined) return;
    setAgents((prev) => (prev.includes(agent) ? prev.filter((a) => a !== agent) : [...prev, agent]));
  }

  const allParamsFilled = preset.params.every((param) => (values[param] ?? '').trim() !== '');
  const canConfirm = projectId !== '' && agents.length > 0 && allParamsFilled && !busy;

  async function confirm(): Promise<void> {
    if (!canConfirm) return;
    setBusy(true);
    const batches = buildInstallBatches(preset, agents, values);
    const result = await applyMcp({ projectId, projectPath, batches });
    setBusy(false);
    if (!result.ok) {
      notify(result.error, 'error');
      return;
    }
    if (result.skipped.length > 0) {
      notify(t('mcp.skippedAgents', { count: String(result.skipped.length) }), 'info');
    }
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t('mcp.installTitle', { name: preset.name })}
      className="sk-mcp-install"
    >
      <div className="sk-mcp-install__form">
        <label className="sk-mcp-install__field">
          <span className="sk-mcp-install__label">{t('mcp.field.project')}</span>
          <ProjectSelect
            projects={projects}
            projectInfo={projectInfo}
            value={projectId}
            onChange={setProjectId}
            placeholder={t('mcp.chooseProject')}
            ariaLabel={t('mcp.field.project')}
            emptyText={t('mcp.filterProjectsEmpty')}
            disabled={busy}
          />
        </label>

        <div className="sk-mcp-install__field">
          <span className="sk-mcp-install__label">{t('mcp.field.agents')}</span>
          <div className="sk-mcp-install__agents">
            {ALL_AGENTS.map((agent) => {
              const reason = disabledReason(agent);
              const checkbox = (
                <Checkbox
                  label={AGENT_LABELS[agent]}
                  checked={agents.includes(agent)}
                  disabled={reason !== undefined || busy}
                  onChange={() => toggleAgent(agent)}
                />
              );
              return (
                <span className="sk-mcp-install__agent" key={agent}>
                  {reason !== undefined ? <Tooltip content={reason}>{checkbox}</Tooltip> : checkbox}
                </span>
              );
            })}
          </div>
        </div>

        {agents.includes('codex') && <Alert tone="info">{t('mcp.codexGlobalNote')}</Alert>}

        {preset.params.length > 0 && (
          <div className="sk-mcp-install__params">
            <span className="sk-mcp-install__label">{t('mcp.field.parameters')}</span>
            {preset.params.map((param) => (
              <label className="sk-mcp-install__field" key={param}>
                <span className="sk-mcp-install__param-label">{param}</span>
                <TextField
                  value={values[param] ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value;
                    setValues((v) => ({ ...v, [param]: next }));
                  }}
                />
              </label>
            ))}
          </div>
        )}

        <div className="sk-mcp-install__actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('mcp.cancel')}
          </Button>
          <Button variant="primary" disabled={!canConfirm} onClick={() => void confirm()}>
            {t('mcp.install')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
