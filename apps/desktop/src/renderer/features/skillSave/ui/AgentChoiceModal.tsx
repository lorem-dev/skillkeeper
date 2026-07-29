/**
 * AgentChoiceModal: the step before the save review, shown only when a scope's
 * checked skills would install nothing because no agent is chosen. One row per
 * scope, each with its own picker: two projects legitimately target different
 * agents, so a single shared set would be wrong.
 *
 * Defaults are a guess, not a decision: a tracked project offers the agents
 * detected in its folder, the global scope offers the agents configured for the
 * application, and either way the agents that scope already has skills or MCP
 * servers installed for are unioned in, so the guess can only ever ADD (see
 * `resolveAgentDefaults`). Detection finding nothing leaves the row empty for
 * the user to fill; it is never reported as an error.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { bridgeClient } from '@/services/bridge';
import type { AgentKind } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button } from '@/shared/ui';
import { AgentSelect } from '@/entities/agent';
import { ProjectIcon } from '@/entities/project';
import {
  agentChoiceScopes,
  installedAgentsByScope,
  mergeAgentDefaults,
  resolveAgentDefaults,
} from '../lib/agentDefaults';
import './AgentChoiceModal.scss';

export interface AgentChoiceModalProps {
  readonly open: boolean;
  /** Scope ids that need agents, in the caller's order (global first). */
  readonly scopeIds: readonly string[];
  readonly onCancel: () => void;
  /** Chosen agents per scope id; only the listed scopes are present. */
  readonly onConfirm: (agentsByScope: Record<string, AgentKind[]>) => void;
  /**
   * Detects a tracked project's configured agents from its folder. Defaults to
   * `bridgeClient.detectProjectAgents`; this is a seam for stories/tests, since
   * the real bridge is unavailable outside Tauri -- it is not something
   * production code overrides.
   */
  readonly detectAgents?: (path: string) => Promise<AgentKind[]>;
}

interface AgentChoiceRow {
  readonly id: string;
  readonly name: string;
  readonly icon: ReactNode;
}

export function AgentChoiceModal({
  open,
  scopeIds,
  onCancel,
  onConfirm,
  detectAgents = bridgeClient.detectProjectAgents,
}: AgentChoiceModalProps) {
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const config = useSkillkeeperStore((s) => s.config);
  const installs = useSkillkeeperStore((s) => s.skills);
  const mcpInstalls = useSkillkeeperStore((s) => s.mcpInstalls);
  const t = useTranslator();

  const [choices, setChoices] = useState<Record<string, AgentKind[]>>({});
  // Scope ids the user has answered themselves. A late-landing detection must
  // not overwrite an answer already given (see the resolve effect below), and
  // that check happens inside a promise callback -- hence a ref, not state.
  const touched = useRef<Set<string>>(new Set());

  // The scopes to render and the scopes to resolve defaults for are ONE list: a
  // row no default was resolved for would be written an empty agent set on
  // confirm, which is exactly the inert save this modal exists to prevent.
  const scopes = useMemo(() => agentChoiceScopes(scopeIds, projects), [scopeIds, projects]);

  // Each row's label + icon: the global scope's own glyph, otherwise the tracked
  // project's. A separate memo from `scopes` so a project icon resolving does
  // not re-trigger detection.
  const rows = useMemo<AgentChoiceRow[]>(
    () =>
      scopes.map(({ id, project }) =>
        project === undefined
          ? { id, name: t('scope.global'), icon: <ProjectIcon global name="" size={18} /> }
          : {
              id,
              name: project.name,
              icon: <ProjectIcon iconUrl={projectInfo[project.id]?.iconDataUrl} name={project.name} size={18} />,
            },
      ),
    [scopes, projectInfo, t],
  );

  // A fresh open starts from a clean slate: neither a previous open's choices
  // nor its "the user answered this" marks may leak into this one.
  useEffect(() => {
    if (!open) return;
    setChoices({});
    touched.current = new Set();
  }, [open]);

  // Resolve each row's default once per open: a tracked project offers its
  // detected agents, the global scope the application's configured agents, both
  // unioned with what that scope already has installed. A rejected or empty
  // detection leaves the row empty for the user to fill -- never surfaced as an
  // error (see `resolveAgentDefaults`). Two guards on a late response: `alive`
  // drops it once the modal closed or `scopes` changed underneath it, and a row
  // the user already answered keeps their answer instead of being reverted.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const enabledAgents = config?.agents.enabled ?? [];
    const installedByScope = installedAgentsByScope(installs, mcpInstalls);
    void resolveAgentDefaults(scopes, enabledAgents, installedByScope, detectAgents).then((resolved) => {
      if (!alive) return;
      setChoices((prev) => mergeAgentDefaults(prev, resolved, touched.current));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scopes]);

  function pick(id: string, next: AgentKind[]): void {
    touched.current.add(id);
    setChoices((prev) => ({ ...prev, [id]: next }));
  }

  const disabled = rows.length === 0 || rows.some((row) => (choices[row.id] ?? []).length === 0);

  function confirm(): void {
    const result: Record<string, AgentKind[]> = {};
    // Only non-empty sets are written: `disabled` above already makes an empty
    // row unreachable here, and writing one would restore the inert save.
    for (const row of rows) {
      const chosen = choices[row.id];
      if (chosen !== undefined && chosen.length > 0) result[row.id] = chosen;
    }
    onConfirm(result);
  }

  return (
    <Modal open={open} onClose={onCancel} title={t('skills.agentChoice.title')} className="sk-agent-choice-modal">
      <div className="sk-agent-choice-modal__body">
        <p className="sk-agent-choice-modal__intro">{t('skills.agentChoice.intro')}</p>
        <ul className="sk-agent-choice-modal__rows">
          {rows.map((row) => (
            <li key={row.id} className="sk-agent-choice-modal__row">
              <span className="sk-agent-choice-modal__scope">
                {row.icon}
                <span className="sk-agent-choice-modal__name">{row.name}</span>
              </span>
              <AgentSelect
                variant="full"
                value={choices[row.id] ?? []}
                onChange={(next) => pick(row.id, next)}
                // Names the scope: its visible name is a sibling span, not
                // programmatically associated, so without this every row's
                // picker would read identically to a screen reader.
                ariaLabel={t('skills.agentChoice.agentsFor', { scope: row.name })}
                placeholder={t('skills.agentChoice.agentsPlaceholder')}
              />
            </li>
          ))}
        </ul>
        <div className="sk-agent-choice-modal__actions">
          <Button variant="secondary" onClick={onCancel}>
            {t('common.close')}
          </Button>
          <Button variant="primary" disabled={disabled} onClick={confirm}>
            {t('skills.agentChoice.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
