import { useMemo, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import {
  aggregateInstalls, SkillCard, SkillDetailsModal,
  type InstalledSkillView,
} from '@/entities/skill';
import { AGENT_LABELS, ALL_AGENTS, formatVersion, formatDate } from '@/domain';
import type { AgentKind } from '@/services/bridge';
import { Page, Toolbar, Button, Tooltip, SearchField, Select } from '@/shared/ui';
import { filterSkills } from './lib/filterSkills';
import './SkillsPage.scss';

export function SkillsPage() {
  const installs = useSkillkeeperStore((s) => s.skills);
  const reload = useSkillkeeperStore((s) => s.reload);
  const t = useTranslator();

  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<AgentKind | 'all'>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);

  const views = useMemo(() => aggregateInstalls(installs), [installs]);
  const shown = useMemo(() => filterSkills(views, { query, agent }), [views, query, agent]);
  const selected: InstalledSkillView | null = useMemo(
    () => views.find((v) => v.key === openKey) ?? null,
    [views, openKey],
  );

  const agentOptions = [
    { value: 'all', label: t('skills.allAgents') },
    ...ALL_AGENTS.map((a) => ({ value: a, label: AGENT_LABELS[a] })),
  ];

  const trailing = (
    <>
      <Tooltip content={t('common.comingSoon')}>
        <Button variant="primary" disabled>{t('skills.add')}</Button>
      </Tooltip>
      <Button variant="secondary" onClick={() => void reload()}>{t('common.refresh')}</Button>
    </>
  );

  const leading = (
    <>
      <SearchField
        placeholder={t('skills.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
        clearLabel={t('common.clear')}
      />
      <Select
        label={t('skills.filterAgent')}
        options={agentOptions}
        value={agent}
        onChange={(e) => setAgent(e.target.value as AgentKind | 'all')}
      />
    </>
  );

  return (
    <Page title={t('nav.skills')}>
      <Toolbar leading={leading} trailing={trailing} />
      {views.length === 0 ? (
        <p className="sk-empty">{t('skills.empty')}</p>
      ) : (
        <div className="sk-skill-list">
          {shown.map((v) => (
            <SkillCard
              key={v.key}
              skill={v}
              versionLabel={formatVersion(v.version)}
              agentLabels={v.agents.map((a) => AGENT_LABELS[a])}
              onOpen={() => setOpenKey(v.key)}
            />
          ))}
        </div>
      )}
      <SkillDetailsModal
        skill={selected}
        open={selected !== null}
        onClose={() => setOpenKey(null)}
        title={t('skills.details.title')}
        agentLabels={selected !== null ? selected.agents.map((a) => AGENT_LABELS[a]) : []}
        filesLabel={t('skills.details.files', { n: String(selected?.fileCount ?? 0) })}
        hooksLabel={t('skills.details.hooks', { n: String(selected?.hookCount ?? 0) })}
        installedAtLabel={t('skills.details.installedAt', { when: formatDate(selected?.installedAt) })}
        destinationLabel={t('skills.details.destination')}
        verifyLabel={t('skills.verify')}
        updateLabel={t('skills.update')}
        comingSoonLabel={t('common.comingSoon')}
      />
    </Page>
  );
}
