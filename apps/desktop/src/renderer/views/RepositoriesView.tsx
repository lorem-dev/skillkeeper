/**
 * Placeholder view: Repositories.
 * Detailed screens are deferred to a follow-up spec.
 */
import { useSkillkeeperStore } from '../store';
import { useTranslator } from '../useTranslator';

export function RepositoriesView() {
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const t = useTranslator();

  return (
    <main style={{ padding: '24px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>{t('nav.repositories')}</h1>
      {repositories.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>No repositories added yet.</p>
      ) : (
        <ul>
          {repositories.map((r) => (
            <li key={r.id}>{r.name}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
