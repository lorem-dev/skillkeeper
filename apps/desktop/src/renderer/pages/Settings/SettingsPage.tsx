/**
 * Settings page. Placeholder screen; detailed flows are a follow-up spec.
 */
import { useTranslator } from '@/systems/i18n';
import { Page } from '@/shared/ui';

export function SettingsPage() {
  const t = useTranslator();

  return (
    <Page title={t('nav.settings')}>
      <p className="sk-empty">{t('settings.comingSoon')}</p>
    </Page>
  );
}
