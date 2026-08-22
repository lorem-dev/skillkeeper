/**
 * Repositories-mode "Install" flow. Step 1: pick a project and the agents to
 * install for (pre-selected from the project's detected agents, remembered per
 * project). Step 2: the modal widens to a TreeView of that project with the
 * chosen skills marked to install (other branches collapsed); the user can add
 * more or uncheck installed skills. Saving (double-confirm) applies the diff
 * with a progress bar.
 *
 * `skillKeys` is the page's EXPLICIT selection -- its hand picks, without the
 * dependencies. The closure has to be recomputed here rather than carried over,
 * because it depends on the project chosen in step 1: a dependency already
 * installed there is not an install, and one that is not must be added. So the
 * modal holds its own hand-pick/repair pair, seeds it with the project's
 * installed set plus the keys it was handed, and derives everything it draws and
 * installs from that -- see `derived` below.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { bridgeClient } from '@/services/bridge';
import type { AgentKind } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, ProgressBar, TreeView, ChangeBadge } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { applyScope, isGlobalScope } from '@/domain';
import { AgentSelect } from '@/entities/agent';
import { ProjectIcon, ProjectSelect } from '@/entities/project';
import {
  buildProjectTree,
  projectNodeId,
  projectSkillKey,
  branchesContaining,
  applyCheckChange,
} from '@/entities/skill';
import type { Selection } from '@/entities/skill';
import { buildInstallScope, resolveInstallSelection, seedInstallSelection } from '../lib/installSelection';
import './SkillInstallModal.scss';

/** Nothing is picked, nothing is being repaired. */
const EMPTY_SELECTION: Selection = { explicit: [], restored: [] };

export interface SkillInstallModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Repo-mode skill keys selected on the page (repoId::group::name). */
  readonly skillKeys: readonly string[];
}

export function SkillInstallModal({ open, onClose, skillKeys }: SkillInstallModalProps) {
  const projects = useSkillkeeperStore((s) => s.projects);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const installs = useSkillkeeperStore((s) => s.skills);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const applySkills = useSkillkeeperStore((s) => s.applySkills);
  const progress = useSkillkeeperStore((s) => s.skillApply);
  const t = useTranslator();

  const [step, setStep] = useState<'project' | 'tree'>('project');
  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) {
      setStep('project');
      setProjectId('');
      setAgents([]);
      setSelection(EMPTY_SELECTION);
      setConfirming(false);
    }
  }, [open]);

  const project = projects.find((p) => p.id === projectId);

  // Default the agent selection to those auto-detected in the project folder
  // whenever a project is chosen; the user can still adjust it below.
  useEffect(() => {
    const proj = projects.find((p) => p.id === projectId);
    if (proj === undefined) return undefined;
    let alive = true;
    void bridgeClient.detectProjectAgents(proj.path).then((detected) => {
      if (alive) setAgents(detected);
    });
    return () => {
      alive = false;
    };
  }, [projectId, projects]);

  // The scope's graph and baseline: the expensive half, and independent of the
  // selection, so it is NOT rebuilt on a checkbox click or an agent change.
  const scope = useMemo(
    () => buildInstallScope(projectId, availableSkills, installs),
    [projectId, availableSkills, installs],
  );
  const { graph, baseline } = scope;
  // The cheap half. Still exactly ONE derivation per render, and the plan is
  // built inside the same call from that same derived set -- see
  // `lib/installSelection`, which owns that rule so it can be unit tested.
  const { derived, plan } = useMemo(
    () => resolveInstallSelection({ scope, selection, installs, agents }),
    [scope, selection, installs, agents],
  );

  function goToTree(): void {
    // The page hands over its EXPLICIT picks only, so the closure is computed
    // here, against THIS project's installed set -- otherwise every dependency
    // the user selected on the page would be silently dropped from the install.
    setSelection(seedInstallSelection(projectId, skillKeys, installs));
    setStep('tree');
  }

  const installedSet = useMemo(() => new Set(baseline), [baseline]);
  const checkedSet = useMemo(() => new Set(derived.shown), [derived]);
  const dependencySet = useMemo(() => new Set(derived.dependency), [derived]);
  const installCount = plan.rows.filter((r) => r.action === 'install').length;
  const removeCount = plan.rows.filter((r) => r.action === 'remove').length;
  const changed = useMemo(
    () => new Set(plan.rows.map((r) => projectSkillKey(projectId, r.ref.repoId, r.ref.group, r.ref.name))),
    [plan, projectId],
  );

  // Exactly one root, for the scope chosen in step 1. The global scope has no
  // `Project` entry to pass through, so it is the global root over an empty
  // projects list; a project is that project's root with the global root
  // suppressed (`null` label) -- its checkboxes would carry another scope's ids,
  // which `buildProjectPlan` drops, so they would show an "add" badge and then
  // do nothing.
  const tree = useMemo(() => {
    if (isGlobalScope(projectId)) return buildProjectTree(availableSkills, repositories, [], t('scope.global'));
    return project !== undefined ? buildProjectTree(availableSkills, repositories, [project], null) : [];
  }, [availableSkills, repositories, project, projectId, t]);

  const decorated = useMemo(() => {
    const decorate = (nodes: readonly TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        if (node.children !== undefined && node.children.length > 0) {
          return { ...node, children: decorate(node.children) };
        }
        const wasInstalled = installedSet.has(node.id);
        const isChecked = checkedSet.has(node.id);
        const isDependency = dependencySet.has(node.id);
        let detail: ReactNode;
        // An installed skill held on by somebody else's dependency IS present;
        // the teal checkbox says why it is held. Guarding this arm on
        // `!isDependency` would leave that row with no badge at all.
        if (wasInstalled && isChecked)
          detail = <ChangeBadge kind="present" label={t('skills.status.present')} />;
        else if (wasInstalled && !isChecked) detail = <ChangeBadge kind="remove" label={t('skills.status.remove')} />;
        else if (!wasInstalled && isChecked)
          detail = (
            <ChangeBadge
              kind={isDependency ? 'add-dependency' : 'add'}
              label={isDependency ? t('skills.status.addDependency') : t('skills.status.add')}
            />
          );
        else detail = undefined;
        return { ...node, detail };
      });
    const withBadges = decorate(tree);
    // The chosen project's root shows its own icon (or a generated placeholder)
    // instead of the default project glyph. Matched by id rather than applied to
    // every root, so no other root can ever wear this project's icon.
    if (project === undefined) return withBadges;
    const rootId = projectNodeId(project.id);
    return withBadges.map((root) =>
      root.id === rootId
        ? {
            ...root,
            icon: <ProjectIcon iconUrl={projectInfo[project.id]?.iconDataUrl} name={project.name} size={18} />,
          }
        : root,
    );
  }, [tree, installedSet, checkedSet, dependencySet, t, project, projectInfo]);

  const expandedIds = useMemo(() => branchesContaining(tree, changed), [tree, changed]);

  const busy = progress !== null;
  const canSave = agents.length > 0 && plan.ops.length > 0 && !busy;

  async function save(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    const scope = applyScope(projectId, projects);
    if (scope === null) return;
    // One call per agent (each op carries that agent's install/remove lists).
    for (const op of plan.ops) {
      const result = await applySkills({
        ...scope,
        agents: [op.agent],
        install: op.install,
        remove: op.remove,
      });
      if (!result.ok) return;
    }
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t('skills.install.title')}
      className={step === 'tree' ? 'sk-skill-modal sk-skill-modal--wide' : 'sk-skill-modal'}
    >
      {step === 'project' ? (
        <div className="sk-skill-modal__step">
          <label className="sk-skill-modal__field">
            <span className="sk-skill-modal__label">{t('skills.install.chooseProject')}</span>
            <ProjectSelect
              projects={projects}
              projectInfo={projectInfo}
              value={projectId}
              onChange={setProjectId}
              placeholder={t('skills.install.chooseProject')}
              ariaLabel={t('skills.install.chooseProject')}
              emptyText={t('skills.filterProjectsEmpty')}
              includeGlobal
              globalLabel={t('scope.global')}
            />
          </label>
          <label className="sk-skill-modal__field">
            <span className="sk-skill-modal__label">{t('skills.install.agents')}</span>
            <AgentSelect
              variant="full"
              value={agents}
              onChange={setAgents}
              ariaLabel={t('skills.install.agents')}
              placeholder={t('skills.install.agentsPlaceholder')}
            />
          </label>
          <div className="sk-skill-modal__actions">
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button
              variant="primary"
              disabled={(project === undefined && !isGlobalScope(projectId)) || agents.length === 0}
              onClick={goToTree}
            >
              {t('skills.install.next')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="sk-skill-modal__step">
          <div className="sk-skill-modal__tree">
            <TreeView
              nodes={decorated}
              checkable
              checkedIds={derived.shown}
              dependencyIds={derived.dependency}
              onCheckedChange={(next) =>
                setSelection(applyCheckChange(selection, baseline, graph, derived.shown, next))
              }
              defaultExpandedIds={expandedIds}
              ariaLabel={t('skills.install.title')}
            />
          </div>
          {busy && progress !== null && (
            <div className="sk-skill-modal__progress">
              <ProgressBar
                value={progress.total > 0 ? progress.done / progress.total : undefined}
                label={t('skills.install.installing')}
              />
              <span className="sk-skill-modal__progress-label">{progress.label}</span>
            </div>
          )}
          <div className="sk-skill-modal__actions">
            <span className="sk-skill-modal__summary">
              {t('skills.install.summary', { add: String(installCount), remove: String(removeCount) })}
            </span>
            <Button variant="secondary" disabled={busy} onClick={() => setStep('project')}>
              {t('skills.install.back')}
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
              {confirming ? t('skills.install.confirm') : t('skills.action.save')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
