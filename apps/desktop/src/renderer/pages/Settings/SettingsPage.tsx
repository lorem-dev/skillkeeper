import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { useTheme, type ThemePref } from '@/systems/theme';
import { buildLanguageOptions, AGENT_LABELS, ALL_AGENTS } from '@/domain';
import type { Lang, AgentKind, UpdatesConfig } from '@/services/bridge';
import {
  Page,
  Toolbar,
  FormSection,
  FormRow,
  Combobox,
  SegmentedControl,
  TextField,
  IntervalStepper,
  Toggle,
  MultiSelect,
} from '@/shared/ui';
import { OpenConfigButton } from './OpenConfigButton';
import './SettingsPage.scss';

interface GitRowProps {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly onCommit: (value: string) => void;
}

function GitRow({ value, label, description, onCommit }: GitRowProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <FormRow label={label} description={description}>
      <TextField
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== value) onCommit(next);
        }}
      />
    </FormRow>
  );
}

export function SettingsPage() {
  const config = useSkillkeeperStore((s) => s.config);
  const updateConfig = useSkillkeeperStore((s) => s.updateConfig);
  const t = useTranslator();
  const { pref, setPref } = useTheme();

  if (config === null) return null;

  const lang = config.general.language;
  const languageOptions = buildLanguageOptions(lang);
  const themeOptions = [
    { value: 'system', label: t('settings.theme.system') },
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
  ];

  return (
    <Page
      title={t('nav.settings')}
      toolbar={
        <Toolbar title={t('nav.settings')} trailing={<OpenConfigButton />} />
      }
    >
      <div className="sk-settings">
        <FormSection title={t('settings.section.general')}>
          <FormRow label={t('settings.language')}>
            <Combobox
              className="sk-settings-language"
              options={languageOptions}
              value={lang}
              onChange={(v) => void updateConfig({ general: { language: v as Lang } })}
              ariaLabel={t('settings.language')}
              placeholder={t('settings.language')}
              emptyText={t('settings.languageEmpty')}
            />
          </FormRow>
          <FormRow label={t('settings.theme')}>
            <SegmentedControl
              label={t('settings.theme')}
              options={themeOptions}
              value={pref}
              onChange={(value) => setPref(value as ThemePref)}
            />
          </FormRow>
          <FormRow label={t('settings.animations')} description={t('settings.animationsHint')}>
            <Toggle
              checked={config.general.animations}
              onChange={(e) => void updateConfig({ general: { animations: e.target.checked } })}
            />
          </FormRow>
        </FormSection>

        <FormSection title={t('settings.section.repositories')}>
          <GitRow
            value={config.repositories.gitPath}
            label={t('settings.git')}
            description={t('settings.gitDescription')}
            onCommit={(gitPath) => void updateConfig({ repositories: { gitPath } })}
          />
          <FormRow label={t('settings.updates.mode')}>
            <SegmentedControl
              label={t('settings.updates.mode')}
              options={[
                { value: 'manual', label: t('settings.updates.mode.manual') },
                { value: 'on-startup', label: t('settings.updates.mode.onStartup') },
                { value: 'scheduled', label: t('settings.updates.mode.scheduled') },
              ]}
              value={config.updates.mode}
              onChange={(v) => void updateConfig({ updates: { mode: v as UpdatesConfig['mode'] } })}
            />
          </FormRow>
          <FormRow label={t('settings.updates.interval')} disabled={config.updates.mode !== 'scheduled'}>
            <IntervalStepper
              minutes={config.updates.intervalMinutes}
              onChange={(intervalMinutes) => void updateConfig({ updates: { intervalMinutes } })}
              // The interval only applies to scheduled checks.
              disabled={config.updates.mode !== 'scheduled'}
              label={t('settings.updates.interval')}
              minutesUnitLabel={t('settings.interval.minutesUnit')}
              hoursUnitLabel={t('settings.interval.hoursUnit')}
              decreaseLabel={t('common.decrease')}
              increaseLabel={t('common.increase')}
            />
          </FormRow>
        </FormSection>

        <FormSection title={t('settings.section.projects')}>
          <FormRow label={t('settings.projects.checkInterval')}>
            <IntervalStepper
              minutes={config.projects.checkIntervalMinutes}
              onChange={(checkIntervalMinutes) => void updateConfig({ projects: { checkIntervalMinutes } })}
              label={t('settings.projects.checkInterval')}
              minutesUnitLabel={t('settings.interval.minutesUnit')}
              hoursUnitLabel={t('settings.interval.hoursUnit')}
              decreaseLabel={t('common.decrease')}
              increaseLabel={t('common.increase')}
            />
          </FormRow>
        </FormSection>

        <FormSection title={t('settings.section.agents')}>
          <FormRow label={t('settings.agents.enabled')}>
            <MultiSelect
              options={ALL_AGENTS.map((a) => ({ value: a, label: AGENT_LABELS[a] }))}
              value={config.agents.enabled}
              onChange={(next) => void updateConfig({ agents: { enabled: next as AgentKind[] } })}
              placeholder={t('settings.agents.placeholder')}
              summary={(count) => t('settings.agents.selected', { count: String(count) })}
              ariaLabel={t('settings.agents.enabled')}
            />
          </FormRow>
        </FormSection>

        <FormSection title={t('settings.section.notifications')}>
          <FormRow label={t('settings.notifications.enabled')}>
            <Toggle
              checked={config.notifications.enabled}
              onChange={(e) => void updateConfig({ notifications: { enabled: e.target.checked } })}
            />
          </FormRow>
        </FormSection>
      </div>
    </Page>
  );
}
