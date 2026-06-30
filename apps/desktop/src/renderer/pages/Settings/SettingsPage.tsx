/**
 * Settings page: config section validity badges, theme control, language
 * read-only display, and a deferred open-config action.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { useTheme, type ThemePref } from '@/systems/theme';
import { Page, Card, Badge, Button, Tooltip, SegmentedControl } from '@/shared/ui';
import './SettingsPage.scss';

const SECTION_KEYS = [
  'general',
  'updates',
  'agents',
  'executables',
  'security',
  'notifications',
] as const;

export function SettingsPage() {
  const config = useSkillkeeperStore((s) => s.config);
  const validity = useSkillkeeperStore((s) => s.configValidity);
  const t = useTranslator();
  const { pref, setPref } = useTheme();

  const themeOptions = [
    { value: 'system', label: t('settings.theme.system') },
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
  ];

  return (
    <Page title={t('nav.settings')}>
      <div className="sk-settings">
        <Card className="sk-settings__row">
          <span>{t('settings.theme')}</span>
          <SegmentedControl
            label={t('settings.theme')}
            options={themeOptions}
            value={pref}
            onChange={(v) => setPref(v as ThemePref)}
          />
        </Card>

        {config !== null && (
          <Card className="sk-settings__row">
            <span>{t('settings.language')}</span>
            <Badge tone="neutral">{config.general.language}</Badge>
          </Card>
        )}

        {SECTION_KEYS.map((key) => {
          const state = validity?.[key];
          return (
            <Card key={key} className="sk-settings__row">
              <span>{t(`settings.section.${key}`)}</span>
              <Badge tone={state === 'invalid' ? 'danger' : 'success'}>
                {state === 'invalid' ? t('settings.invalid') : t('settings.valid')}
              </Badge>
            </Card>
          );
        })}

        <div className="sk-settings__actions">
          <Tooltip content={t('common.comingSoon')}>
            <Button variant="secondary" disabled>{t('settings.openConfig')}</Button>
          </Tooltip>
        </div>
      </div>
    </Page>
  );
}
