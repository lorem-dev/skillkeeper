import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { useTheme, type ThemePref } from '@/systems/theme';
import { buildLanguageOptions } from '@/domain';
import type { Lang } from '@/services/bridge';
import { Page, Toolbar, FormSection, FormRow, Select, SegmentedControl, TextField } from '@/shared/ui';
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
    <Page title={t('nav.settings')}>
      {/* Interim placement: Page has no toolbar slot yet, so the toolbar is
          rendered as a plain row without a title (Page already renders the
          h1). Migrate to Page's toolbar slot once it lands. */}
      <Toolbar trailing={<OpenConfigButton />} />
      <div className="sk-settings">
        <FormSection title={t('settings.section.general')}>
          <FormRow label={t('settings.language')}>
            <Select
              options={languageOptions}
              value={lang}
              onChange={(e) => void updateConfig({ general: { language: e.target.value as Lang } })}
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
        </FormSection>

        <FormSection title={t('settings.section.repositories')}>
          <GitRow
            value={config.repositories.gitPath}
            label={t('settings.git')}
            description={t('settings.gitDescription')}
            onCommit={(gitPath) => void updateConfig({ repositories: { gitPath } })}
          />
        </FormSection>
      </div>
    </Page>
  );
}
