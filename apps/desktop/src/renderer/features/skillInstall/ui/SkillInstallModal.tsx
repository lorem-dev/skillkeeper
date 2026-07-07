/**
 * Repositories-mode "Install" flow. Step 1: pick a project and the agents to
 * install for (pre-selected from the project's detected agents, remembered per
 * project). Step 2: the modal widens to a TreeView of that project with the
 * chosen skills marked to install (other branches collapsed); the user can add
 * more or uncheck installed skills. Saving (double-confirm) applies the diff
 * with a progress bar.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { bridgeClient } from '@/services/bridge';
import type { AgentKind, SkillRef } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { Modal, Button, Select, ProgressBar, TreeView, ChangeBadge } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { AgentSelect } from '@/entities/agent';
import {
  buildProjectTree,
  installedLeafIds,
  projectSkillKey,
  parseRepoSkillKey,
  parseProjectSkillKey,
  branchesContaining,
} from '@/entities/skill';
import './SkillInstallModal.scss';

export interface SkillInstallModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Repo-mode skill keys selected on the page (repoId::group::name). */
  readonly skillKeys: readonly string[];
}

const agentsStorageKey = (projectId: string): string => `sk-install-agents-${projectId}`;

function toRefs(keys: readonly string[]): SkillRef[] {
  return keys.map((k) => {
    const p = parseProjectSkillKey(k);
    return { repoId: p.repoId, group: p.group, name: p.name };
  });
}

export function SkillInstallModal({ open, onClose, skillKeys }: SkillInstallModalProps) {
  const projects = useSkillkeeperStore((s) => s.projects);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const installs = useSkillkeeperStore((s) => s.skills);
  const applySkills = useSkillkeeperStore((s) => s.applySkills);
  const progress = useSkillkeeperStore((s) => s.skillApply);
  const t = useTranslator();

  const [step, setStep] = useState<'project' | 'tree'>('project');
  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) {
      setStep('project');
      setProjectId('');
      setAgents([]);
      setChecked([]);
      setConfirming(false);
    }
  }, [open]);

  const project = projects.find((p) => p.id === projectId);
  const projectPath = project?.path ?? '';

  // Pre-select agents when a project is chosen: the remembered set, else detect.
  useEffect(() => {
    const proj = projects.find((p) => p.id === projectId);
    if (proj === undefined) return undefined;
    const remembered = localStorage.getItem(agentsStorageKey(proj.id));
    if (remembered !== null) {
      setAgents(JSON.parse(remembered) as AgentKind[]);
      return undefined;
    }
    let alive = true;
    void bridgeClient.detectProjectAgents(proj.path).then((detected) => {
      if (alive) setAgents(detected);
    });
    return () => {
      alive = false;
    };
  }, [projectId, projects]);

  function changeAgents(next: AgentKind[]): void {
    setAgents(next);
    if (project !== undefined) localStorage.setItem(agentsStorageKey(project.id), JSON.stringify(next));
  }

  const installedSet = useMemo(
    () => new Set(installedLeafIds(installs).filter((k) => parseProjectSkillKey(k).projectId === projectId)),
    [installs, projectId],
  );

  const toInstallKeys = useMemo(
    () =>
      skillKeys.map((k) => {
        const r = parseRepoSkillKey(k);
        return projectSkillKey(projectId, r.repoId, r.group, r.name);
      }),
    [skillKeys, projectId],
  );

  function goToTree(): void {
    setChecked([...new Set([...installedSet, ...toInstallKeys])]);
    setStep('tree');
  }

  const checkedSet = useMemo(() => new Set(checked), [checked]);
  const toAdd = useMemo(() => checked.filter((k) => !installedSet.has(k)), [checked, installedSet]);
  const toRemove = useMemo(
    () => [...installedSet].filter((k) => !checkedSet.has(k)),
    [installedSet, checkedSet],
  );
  const changed = useMemo(() => new Set([...toAdd, ...toRemove]), [toAdd, toRemove]);

  const tree = useMemo(
    () => (project !== undefined ? buildProjectTree(availableSkills, repositories, [project]) : []),
    [availableSkills, repositories, project],
  );

  const decorated = useMemo(() => {
    const decorate = (nodes: readonly TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        if (node.children !== undefined && node.children.length > 0) {
          return { ...node, children: decorate(node.children) };
        }
        const wasInstalled = installedSet.has(node.id);
        const isChecked = checkedSet.has(node.id);
        let detail: ReactNode;
        if (wasInstalled && isChecked) detail = <ChangeBadge kind="present" label={t('skills.status.present')} />;
        else if (wasInstalled && !isChecked) detail = <ChangeBadge kind="remove" label={t('skills.status.remove')} />;
        else if (!wasInstalled && isChecked) detail = <ChangeBadge kind="add" label={t('skills.status.add')} />;
        else detail = undefined;
        return { ...node, detail };
      });
    return decorate(tree);
  }, [tree, installedSet, checkedSet, t]);

  const expandedIds = useMemo(() => branchesContaining(tree, changed), [tree, changed]);

  const busy = progress !== null;
  const canSave = agents.length > 0 && changed.size > 0 && !busy;

  async function save(): Promise<void> {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    const result = await applySkills({
      projectId,
      projectPath,
      agents,
      install: toRefs(toAdd),
      remove: toRefs(toRemove),
    });
    if (result.ok) onClose();
  }

  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }));

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
            <Select
              options={projectOptions}
              value={projectId}
              onChange={setProjectId}
              placeholder={t('skills.install.chooseProject')}
              ariaLabel={t('skills.install.chooseProject')}
            />
          </label>
          <label className="sk-skill-modal__field">
            <span className="sk-skill-modal__label">{t('skills.install.agents')}</span>
            <AgentSelect value={agents} onChange={changeAgents} ariaLabel={t('skills.install.agents')} />
          </label>
          <div className="sk-skill-modal__actions">
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button variant="primary" disabled={project === undefined} onClick={goToTree}>
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
              checkboxLevels={[1, 2, 3]}
              checkedIds={checked}
              onCheckedChange={setChecked}
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
              {t('skills.install.summary', { add: String(toAdd.length), remove: String(toRemove.length) })}
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
