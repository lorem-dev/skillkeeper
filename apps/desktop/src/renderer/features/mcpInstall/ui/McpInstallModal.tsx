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
import { bridgeClient } from '@/services/bridge';
import type { AgentKind, DescriptionSpan } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, TextField, Checkbox, Tooltip, Select, DescriptionText } from '@/shared/ui';
import { ProjectSelect } from '@/entities/project';
import { ALL_AGENTS, AGENT_LABELS, applyScope } from '@/domain';
import { supportsTransport } from '../lib/supportsTransport';
import { supportsOauth } from '../lib/supportsOauth';
import { buildInstallBatches } from '../lib/buildBatches';
import { installNotesToMessages } from '../lib/installNotesToMessages';
import { mcpSkipsToMessages } from '../lib/mcpSkipsToMessages';
import { descriptionQueries, spansForServer, spansForParam } from '../lib/descriptionSpanQueries';
import { paramValueValid } from '../lib/paramValueValid';
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
  /**
   * Fetches parsed description spans for the server and its parameters, in
   * the order `descriptionQueries` produces them. Defaults to
   * `bridgeClient.mcpDescriptionSpans`; this is a seam for stories/tests,
   * since the real bridge command is unavailable outside Tauri -- it is not
   * something production code overrides.
   */
  readonly getDescriptionSpans?: (descriptions: string[]) => Promise<DescriptionSpan[][]>;
}

export function McpInstallModal({
  open,
  preset,
  preselectedProjectId,
  initialValues,
  onClose,
  getDescriptionSpans = bridgeClient.mcpDescriptionSpans,
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
  // Populated once per open by a single `mcp_description_spans` call (see
  // `descriptionQueries`/`spansForServer`/`spansForParam`); empty until that
  // resolves, which reads as "no description yet" the same way "none
  // authored" does -- both render nothing.
  const [descriptionSpans, setDescriptionSpans] = useState<DescriptionSpan[][]>([]);

  // Reset the form every time the modal opens -- mirrors SkillInstallModal's
  // reset-on-open effect. Deliberately keyed only on `open` (not on
  // `preset`/`initialValues`, whose identity a caller may not keep stable
  // across renders): a mounted, still-open modal is never expected to swap
  // its preset out from under the user mid-edit.
  useEffect(() => {
    if (!open) return undefined;
    setProjectId(preselectedProjectId ?? '');
    setAgents([]);
    const seeded: Record<string, string> = {};
    for (const param of preset.params) seeded[param] = initialValues?.[param] ?? '';
    setValues(seeded);
    setBusy(false);
    setDescriptionSpans([]);
    // Alive-flag guard (mirrors `SkillInstallModal`'s agent-detection effect):
    // open A, close, open B before A's spans resolve must not land A's
    // descriptions on B's parameters. The command is synchronous work on the
    // backend, so in practice this is a sub-frame race, not a lasting one --
    // but it is still the last path to a silently wrong description.
    let alive = true;
    void getDescriptionSpans(descriptionQueries(preset))
      .then((spans) => {
        if (alive) setDescriptionSpans(spans);
      })
      .catch(() => {
        // Best-effort: a failed fetch just leaves every description
        // unrendered, exactly like "none authored" -- the rest of the form
        // (project, agents, parameter values) is unaffected either way.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Hands a link span's own `url` to the backend opener; never called with
   *  anything else (see `DescriptionText`'s doc comment). */
  function openLink(url: string): void {
    void bridgeClient.openExternalUrl(url);
  }

  /** Reason text for a disabled agent checkbox, or undefined when selectable. */
  function disabledReason(agent: AgentKind): string | undefined {
    if (!supportsTransport(agent, preset.def.type)) {
      return t('mcp.transportUnsupported', {
        agent: AGENT_LABELS[agent],
        transport: t(`mcp.protocol.${preset.def.type}`),
      });
    }
    if (preset.def.oauth !== undefined && !supportsOauth(agent)) {
      return t('mcp.oauthUnsupported', { agent: AGENT_LABELS[agent] });
    }
    return undefined;
  }

  function toggleAgent(agent: AgentKind): void {
    if (disabledReason(agent) !== undefined) return;
    setAgents((prev) => (prev.includes(agent) ? prev.filter((a) => a !== agent) : [...prev, agent]));
  }

  const allParamsFilled = preset.params.every((param) =>
    paramValueValid(preset.def.parameters[param], values[param] ?? ''),
  );
  const canConfirm = projectId !== '' && agents.length > 0 && allParamsFilled && !busy;

  async function confirm(): Promise<void> {
    if (!canConfirm) return;
    const scope = applyScope(projectId, projects);
    if (scope === null) return;
    setBusy(true);
    const batches = buildInstallBatches(preset, agents, values);
    const result = await applyMcp({ ...scope, batches });
    setBusy(false);
    if (!result.ok) {
      notify(result.error, 'error');
      return;
    }
    // One message per declined agent naming the rule that declined it: a
    // transport skip and an oauth skip have different remedies, and a bare
    // count told the user neither.
    for (const message of mcpSkipsToMessages(result.skipped, t)) notify(message, 'info');
    // Deduplicated: two agents dropping the same field must not say it twice.
    for (const message of installNotesToMessages(result.installed, t)) notify(message, 'info');
    onClose();
  }

  // Truncated AND parsed by the backend already (see `descriptionSpans`'
  // doc comment) -- never re-truncated or re-parsed here.
  const serverSpans = spansForServer(preset, descriptionSpans);

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t('mcp.installTitle', { name: preset.name })}
      className="sk-mcp-install"
    >
      <div className="sk-mcp-install__form">
        {serverSpans !== undefined && (
          <DescriptionText spans={serverSpans} onOpenLink={openLink} className="sk-mcp-install__description" />
        )}

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
            includeGlobal
            globalLabel={t('scope.global')}
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

        {preset.params.length > 0 && (
          <div className="sk-mcp-install__params">
            <span className="sk-mcp-install__label">{t('mcp.field.parameters')}</span>
            {preset.params.map((param) => {
              const meta = preset.def.parameters[param];
              const options = meta?.options ?? [];
              const paramSpans = spansForParam(preset, descriptionSpans, param);
              return (
                <label className="sk-mcp-install__field" key={param}>
                  <span className="sk-mcp-install__param-label">{param}</span>
                  {paramSpans !== undefined && (
                    <DescriptionText spans={paramSpans} onOpenLink={openLink} className="sk-mcp-install__param-help" />
                  )}
                  {options.length > 0 ? (
                    <>
                      <Select
                        options={options.map((o) => ({ value: o.value, label: o.label }))}
                        value={values[param] ?? ''}
                        onChange={(next) => setValues((v) => ({ ...v, [param]: next }))}
                        placeholder={t('mcp.param.choosePlaceholder')}
                        ariaLabel={param}
                        disabled={busy}
                      />
                      {/* Why a hint under a control that cannot produce an
                          invalid value: an option-constrained parameter starts
                          with nothing selected, and Confirm is disabled until
                          one is. Saying so beats a disabled button with no
                          stated reason. */}
                      {!paramValueValid(meta, values[param] ?? '') && (
                        <span className="sk-mcp-install__param-help">{t('mcp.error.invalidOption')}</span>
                      )}
                    </>
                  ) : (
                    <TextField
                      value={values[param] ?? ''}
                      disabled={busy}
                      onChange={(e) => {
                        const next = e.target.value;
                        setValues((v) => ({ ...v, [param]: next }));
                      }}
                    />
                  )}
                </label>
              );
            })}
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
