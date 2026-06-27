/**
 * Placeholder view: Settings.
 * Detailed screens are deferred to a follow-up spec.
 */
import { useTranslator } from '../useTranslator';

export function SettingsView() {
  const t = useTranslator();

  return (
    <main style={{ padding: '24px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>{t('nav.settings')}</h1>
      <p style={{ color: '#9ca3af' }}>Settings screen coming soon.</p>
    </main>
  );
}
