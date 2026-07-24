/**
 * The language + theme FormRows shared by the Settings page and the
 * onboarding welcome screen -- both write straight to config the same way, so
 * the rows live here once instead of duplicated in each caller.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTheme, type ThemePref } from '@/systems/theme';
import { useTranslator, ensureCatalog } from '@/systems/i18n';
import { buildLanguageOptions } from '@/domain';
import { Combobox, SegmentedControl, FormRow } from '@/shared/ui';
import type { Lang } from '@/services/bridge';

export interface LanguageThemeFieldsProps {
  /** Class applied to the language Combobox, so each caller can keep its own
   *  width rule. */
  readonly languageClassName?: string;
}

export function LanguageThemeFields({ languageClassName }: LanguageThemeFieldsProps) {
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
    <>
      <FormRow label={t('settings.language')}>
        <Combobox
          className={languageClassName}
          options={languageOptions}
          value={lang}
          onChange={(v) =>
            void ensureCatalog(v as Lang).then(() => updateConfig({ general: { language: v as Lang } }))
          }
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
          onChange={(v) => setPref(v as ThemePref)}
        />
      </FormRow>
    </>
  );
}
