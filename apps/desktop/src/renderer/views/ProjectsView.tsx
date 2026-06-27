/**
 * Placeholder view: Projects.
 * Detailed screens are deferred to a follow-up spec.
 */
import { useSkillkeeperStore } from '../store';
import { useTranslator } from '../useTranslator';

export function ProjectsView() {
  const projects = useSkillkeeperStore((s) => s.projects);
  const t = useTranslator();

  return (
    <main style={{ padding: '24px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>{t('nav.projects')}</h1>
      {projects.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>No projects tracked yet.</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
