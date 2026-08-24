/**
 * Projects-mode "Save" flow. Shows the pending changes -- at (skill, agent)
 * granularity, so changing a scope's agents re-syncs even already-installed
 * skills -- in a table (Project | Repository | Skill | Action | Agents). Scopes
 * are the global (user-wide) scope plus every tracked project. Also folds in
 * MCP instance rows for the same reason (design spec "MCP support" section 8,
 * "Skills-change modal (agent changes)"): an agent added to (or dropped from)
 * a scope's chosen set adds (or removes) that agent's copy of every
 * already-installed MCP instance, tagged with an "MCP" badge so they read as
 * distinct from skill rows. Confirm (double-confirm) applies every scope's
 * skill plan, then its MCP plan (plus any freshly-prompted params), in turn
 * with a progress bar.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { bridgeClient } from '@/services/bridge';
import type { AgentKind, DescriptionSpan, McpBatch } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, ProgressBar, Table, Icon, Badge, TextField, Select, DescriptionText } from '@/shared/ui';
import type { TableColumn, TableRow } from '@/shared/ui';
import { AGENT_LABELS, applyScope, GLOBAL_SCOPE_ID } from '@/domain';
import { buildProjectPlan } from '@/entities/skill';
import {
  buildInstallBatches,
  descriptionQueries,
  installNotesToMessages,
  mcpSkipsToMessages,
  paramValueValid,
  spansForParam,
} from '@/features/mcpInstall';
import { buildProjectMcpPlan } from '../lib/mcpPlan';
import './SkillSaveModal.scss';

/** Key for the per-row param-prompt draft values, unique across scopes. */
function promptKey(scopeId: string, rowKey: string): string {
  return `${scopeId}::${rowKey}`;
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

  // The scopes a save reviews: the global scope first, then every tracked
  // project -- mirrors the tree builders' scope ordering.
  const scopes = useMemo(
    () => [
      { id: GLOBAL_SCOPE_ID, name: t('scope.global') },
      ...projects.map((p) => ({ id: p.id, name: p.name })),
    ],
    [projects, t],
  );

  // A non-empty plan per scope (skill+agent diff vs the installed state).
  const plans = useMemo(
    () =>
      scopes
        .map((scope) => ({
          scope,
          plan: buildProjectPlan(scope.id, checkedIds, installs, projectAgents[scope.id] ?? []),
        }))
        .filter(({ plan }) => plan.ops.length > 0),
    [scopes, checkedIds, installs, projectAgents],
  );

  // Same idea for MCP instances: one row per (identity, action) per scope,
  // grouping every agent's copy of the same installed instance-source. Uses
  // the same `scopes` list as the skill plans above (global first, then every
  // tracked project) -- `McpInstall.projectId` already stores the literal
  // `'global'` string for a user-wide instance (unlike `AgentTarget`, it has
  // no separate scope field to reconcile), so `buildProjectMcpPlan` itself
  // needs no change: passing `GLOBAL_SCOPE_ID` through as `projectId` already
  // selects the right installs.
  const mcpPlans = useMemo(
    () =>
      scopes
        .map((scope) => ({
          scope,
          plan: buildProjectMcpPlan(mcpInstalls, scope.id, projectAgents[scope.id] ?? [], mcpPresets),
        }))
        .filter(({ plan }) => plan.rows.length > 0),
    [scopes, mcpInstalls, projectAgents, mcpPresets],
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
  const skillRows: TableRow[] = plans.flatMap(({ scope, plan }) =>
    plan.ops.flatMap((op) => {
      const make = (ref: (typeof op.install)[number], action: 'install' | 'remove'): TableRow => {
        const skillLabel = ref.group !== undefined ? `${ref.group} / ${ref.name}` : ref.name;
        const skillKey = `${ref.repoId}::${ref.group ?? ''}::${ref.name}`;
        return {
          id: `${scope.id}:${op.agent}:${action}:${skillKey}`,
          cells: [
            scope.name,
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
  const mcpRows: TableRow[] = mcpPlans.flatMap(({ scope, plan }) =>
    plan.rows.map((row) => ({
      id: `mcp:${scope.id}:${row.key}`,
      cells: [
        scope.name,
        row.preset?.origin === 'repo' ? (repoName.get(row.preset.repoId ?? '') ?? '') : '',
        <span key="s" className="sk-save-modal__mcplabel">
          <Icon name="mcp" size={14} />
          {row.label}
          <Badge tone="neutral">{t('nav.mcp')}</Badge>
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
  const promptRows = mcpPlans.flatMap(({ scope, plan }) =>
    plan.rows
      .filter((row) => row.action === 'install' && row.needsParamPrompt && row.preset !== undefined)
      .map((row) => ({ scope, row, preset: row.preset! })),
  );
  // Gated on `paramValueValid`, not on non-blankness: a parameter with
  // `options` accepts only one of those option values, and this modal applies
  // its batch straight to `applyMcp`, which refuses anything else. Gating on
  // blankness alone let a typed value through, and by then the skill plans
  // above had already been applied -- leaving a half-applied change and no way
  // to supply a valid value from this modal.
  const missingMcpParams = promptRows.some(({ scope, row, preset }) => {
    const values = mcpParamValues[promptKey(scope.id, row.key)] ?? {};
    return preset.params.some((p) => !paramValueValid(preset.def.parameters[p], values[p] ?? ''));
  });

  // One `mcp_description_spans` call per distinct preset behind a prompt row,
  // keyed by preset id because this modal can prompt for several presets at
  // once. Best-effort, exactly as in `McpInstallModal`: a failed fetch leaves
  // every description unrendered, which reads as "none authored".
  const promptPresetIds = useMemo(
    () => [...new Set(promptRows.map(({ preset }) => preset.id))].sort().join('\n'),
    [promptRows],
  );
  const [promptSpans, setPromptSpans] = useState<Record<string, DescriptionSpan[][]>>({});

  useEffect(() => {
    if (!open) return undefined;
    const ids = promptPresetIds === '' ? [] : promptPresetIds.split('\n');
    let alive = true;
    void Promise.all(
      ids.map(async (id): Promise<readonly [string, DescriptionSpan[][]]> => {
        const preset = mcpPresets.find((p) => p.id === id);
        if (preset === undefined) return [id, []] as const;
        return [id, await bridgeClient.mcpDescriptionSpans(descriptionQueries(preset))] as const;
      }),
    )
      .then((entries) => {
        if (alive) setPromptSpans(Object.fromEntries(entries));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, promptPresetIds, mcpPresets]);

  /** Hands a link span's own `url` to the backend opener; never called with
   *  anything else (see `DescriptionText`'s doc comment). */
  function openLink(url: string): void {
    void bridgeClient.openExternalUrl(url);
  }

  const busy = progress !== null;

  async function confirm(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    // Apply each scope's plan; one applySkills call per agent op.
    for (const { scope, plan } of plans) {
      const args = applyScope(scope.id, projects);
      if (args === null) continue;
      for (const op of plan.ops) {
        const result = await applySkills({
          ...args,
          agents: [op.agent],
          install: op.install,
          remove: op.remove,
        });
        if (!result.ok) return;
      }
    }
    // Apply each scope's MCP plan, plus any install this review prompted for
    // (its preset's params were not yet known anywhere).
    for (const { scope, plan } of mcpPlans) {
      const args = applyScope(scope.id, projects);
      if (args === null) continue;
      const prompted: McpBatch[] = plan.rows
        .filter((row) => row.action === 'install' && row.needsParamPrompt && row.preset !== undefined)
        .flatMap((row) =>
          buildInstallBatches(row.preset!, row.agents, mcpParamValues[promptKey(scope.id, row.key)] ?? {}),
        );
      const batches = [...plan.batches, ...prompted];
      if (batches.length === 0) continue;
      const result = await applyMcp({ ...args, batches });
      if (!result.ok) {
        notify(result.error, 'error');
        return;
      }
      // Reported for the same reason `McpInstallModal` reports them: without
      // this the modal closes on unqualified success while an agent was
      // declined or a writer dropped an auth field, and the user has no way to
      // learn either.
      for (const message of mcpSkipsToMessages(result.skipped, t)) notify(message, 'info');
      for (const message of installNotesToMessages(result.installed, t)) notify(message, 'info');
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
            <span className="sk-save-modal__mcpprompt-title">{t('mcp.needsParamsNotice')}</span>
            {promptRows.map(({ scope, row, preset }) => (
              <div key={`${scope.id}::${row.key}`} className="sk-save-modal__mcpprompt-row">
                <span className="sk-save-modal__mcpprompt-label">
                  {scope.name} / {row.label}
                </span>
                {preset.params.map((param) => {
                  const values = mcpParamValues[promptKey(scope.id, row.key)] ?? {};
                  const value = values[param] ?? '';
                  const meta = preset.def.parameters[param];
                  const options = meta?.options ?? [];
                  const paramSpans = spansForParam(preset, promptSpans[preset.id] ?? [], param);
                  const setValue = (next: string): void =>
                    setMcpParamValues((prev) => {
                      const k = promptKey(scope.id, row.key);
                      return { ...prev, [k]: { ...prev[k], [param]: next } };
                    });
                  return (
                    <label key={param} className="sk-save-modal__mcpprompt-field">
                      <span>{param}</span>
                      {paramSpans !== undefined && (
                        <DescriptionText
                          spans={paramSpans}
                          onOpenLink={openLink}
                          className="sk-save-modal__mcpprompt-help"
                        />
                      )}
                      {options.length > 0 ? (
                        <>
                          <Select
                            options={options.map((o) => ({ value: o.value, label: o.label }))}
                            value={value}
                            onChange={setValue}
                            placeholder={t('mcp.param.choosePlaceholder')}
                            ariaLabel={param}
                            disabled={busy}
                          />
                          {/* The third of the three Select surfaces, same
                              reasoning as the install modal's: an
                              option-constrained parameter starts with nothing
                              selected and Save stays disabled until one is, so
                              the reason is stated rather than left to be
                              guessed from a dead button. */}
                          {!paramValueValid(meta, value) && (
                            <span className="sk-save-modal__mcpprompt-help">{t('mcp.error.invalidOption')}</span>
                          )}
                        </>
                      ) : (
                        <TextField value={value} disabled={busy} onChange={(e) => setValue(e.target.value)} />
                      )}
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
