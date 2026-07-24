/**
 * OnboardingDemoTree: the real `TreeView`, fed a small fixture, used by the
 * onboarding tour's skills and agents steps. Renders the actual shared
 * component so the tour always matches it -- made read-only by an
 * absolutely-positioned transparent layer that absorbs every click, rather
 * than by disabling the tree's own controls.
 *
 * The fixture mirrors the real Skills Management page (pages/Skills/
 * ManagementPage.tsx): a project root carrying its generative `ProjectIcon` and
 * an `AgentSelect` picker as its trailing control, repo/group branches, and
 * skill leaves whose install-status badge (present/add/remove) renders in the
 * `detail` (count) column exactly as there, computed from the installed
 * baseline vs the checked set -- so checkboxes and the status column both show.
 *
 * A `features` module (not `systems/onboarding`, which may not import
 * `entities`): it composes `ProjectIcon` (`entities/project`) and
 * `AgentSelect` (`entities/agent`) alongside the shared `TreeView`, and is
 * injected into `OnboardingOverlay` from `app/App.tsx` via a render prop.
 */
import type { ReactNode } from 'react';
import { TreeView, Icon, ChangeBadge } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { ProjectIcon } from '@/entities/project';
import { AgentSelect } from '@/entities/agent';
import type { AgentKind } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import type { DemoTreeVariant } from '@/systems/onboarding';
import './OnboardingDemoTree.scss';

export interface OnboardingDemoTreeProps {
  readonly variant: DemoTreeVariant;
}

const repoIcon = <Icon name="repositories" size={18} />;
const groupIcon = <Icon name="skill-group" size={18} />;
const skillIcon = <Icon name="skills" size={18} />;

const DEMO_AGENTS: AgentKind[] = ['claude', 'codex'];

export function OnboardingDemoTree({ variant }: OnboardingDemoTreeProps) {
  const t = useTranslator();
  const ariaLabel = t('skills.managementTitle');

  // The per-project agent picker, shown as the project row's trailing control
  // exactly as on the Skills Management page.
  const agentControl = (
    <AgentSelect
      value={DEMO_AGENTS}
      onChange={() => {}}
      ariaLabel={t('skills.agentsLabel')}
      tooltip={t('skills.agentsTooltip')}
    />
  );

  const projectIcon = <ProjectIcon name={t('onboarding.tree.project')} size={18} />;

  if (variant === 'agents') {
    const nodes: TreeNode[] = [
      {
        id: 'demo-project',
        label: t('onboarding.tree.project'),
        icon: projectIcon,
        selectable: false,
        trailing: agentControl,
      },
    ];
    return (
      <div className="sk-onboarding-demo sk-onboarding-demo--agents">
        <TreeView nodes={nodes} defaultExpandedIds={[]} ariaLabel={ariaLabel} animate={false} />
        <div className="sk-onboarding-demo__block" aria-hidden="true" />
      </div>
    );
  }

  // Installed baseline vs the checked set, mirroring the real page's diff:
  // installed+checked -> present (grey), installed+unchecked -> remove (red),
  // not-installed+checked -> add (green). `detail` renders in the count column.
  const installed = new Set(['sk-a']);
  const checkedIds = variant === 'skills-installed' ? ['sk-a'] : ['sk-b'];
  const checked = new Set(checkedIds);
  const statusBadge = (id: string): ReactNode => {
    const wasInstalled = installed.has(id);
    const isChecked = checked.has(id);
    if (wasInstalled && isChecked)
      return <ChangeBadge kind="present" label={t('skills.status.present')} />;
    if (wasInstalled && !isChecked)
      return <ChangeBadge kind="remove" label={t('skills.status.remove')} />;
    if (!wasInstalled && isChecked)
      return <ChangeBadge kind="add" label={t('skills.status.add')} />;
    return undefined;
  };
  const skill = (id: string, name: string): TreeNode => ({
    id,
    label: name,
    icon: skillIcon,
    detail: statusBadge(id),
  });

  const nodes: TreeNode[] = [
    {
      id: 'demo-project',
      label: t('onboarding.tree.project'),
      icon: projectIcon,
      selectable: false,
      trailing: agentControl,
      children: [
        {
          id: 'demo-repo',
          label: t('onboarding.tree.repository'),
          icon: repoIcon,
          children: [
            {
              id: 'demo-group',
              label: t('onboarding.tree.skillset'),
              icon: groupIcon,
              children: [
                skill('sk-a', t('onboarding.tree.skillA')),
                skill('sk-b', t('onboarding.tree.skillB')),
                skill('sk-c', t('onboarding.tree.skillC')),
              ],
            },
          ],
        },
      ],
    },
  ];

  return (
    <div className="sk-onboarding-demo">
      <TreeView
        nodes={nodes}
        checkable
        checkboxLevels={[1, 2, 3]}
        checkedIds={checkedIds}
        onCheckedChange={() => {}}
        defaultExpandedIds={['demo-project', 'demo-repo', 'demo-group']}
        ariaLabel={ariaLabel}
        animate={false}
      />
      <div className="sk-onboarding-demo__block" aria-hidden="true" />
    </div>
  );
}
