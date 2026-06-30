/**
 * Skills page. Placeholder screen; detailed flows are a follow-up spec.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Page } from '@/shared/ui';

export function SkillsPage() {
  const skills = useSkillkeeperStore((s) => s.skills);
  const t = useTranslator();

  return (
    <Page title={t('nav.skills')}>
      {skills.length === 0 ? (
        <p className="sk-empty">{t('skills.empty')}</p>
      ) : (
        <p>{t('skills.count', { n: String(skills.length) })}</p>
      )}
    </Page>
  );
}
