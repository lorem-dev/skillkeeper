/**
 * Placeholder view: Skills.
 * Detailed screens are deferred to a follow-up spec.
 */
import { useSkillkeeperStore } from '../store';
import { useTranslator } from '../useTranslator';

export function SkillsView() {
  const skills = useSkillkeeperStore((s) => s.skills);
  const t = useTranslator();

  return (
    <main style={{ padding: '24px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>{t('nav.skills')}</h1>
      {skills.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>No skills installed yet.</p>
      ) : (
        <p>{t('skills.count', { n: String(skills.length) })}</p>
      )}
    </main>
  );
}
