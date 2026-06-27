/**
 * Root application component.
 *
 * Renders: a sidebar for navigation, the config-validity banner, and a
 * placeholder content area that shows the selected view. No router library is
 * used for the v1 shell -- a simple useState drives view selection.
 */
import { useState, useEffect } from 'react';
import { useSkillkeeperStore } from './store';
import { useTranslator } from './useTranslator';
import { ConfigBanner } from './ConfigBanner';
import { RepositoriesView } from './views/RepositoriesView';
import { SkillsView } from './views/SkillsView';
import { ProjectsView } from './views/ProjectsView';
import { SettingsView } from './views/SettingsView';

type View = 'repositories' | 'skills' | 'projects' | 'settings';

const NAV_ITEMS: { id: View; key: 'nav.repositories' | 'nav.skills' | 'nav.projects' | 'nav.settings' }[] = [
  { id: 'repositories', key: 'nav.repositories' },
  { id: 'skills', key: 'nav.skills' },
  { id: 'projects', key: 'nav.projects' },
  { id: 'settings', key: 'nav.settings' },
];

export function App() {
  const [activeView, setActiveView] = useState<View>('repositories');
  const loadAll = useSkillkeeperStore((s) => s.loadAll);
  const loading = useSkillkeeperStore((s) => s.loading);
  const error = useSkillkeeperStore((s) => s.error);
  const t = useTranslator();

  useEffect(() => {
    void loadAll(window.skillkeeper);
  }, [loadAll]);

  function renderView() {
    switch (activeView) {
      case 'repositories':
        return <RepositoriesView />;
      case 'skills':
        return <SkillsView />;
      case 'projects':
        return <ProjectsView />;
      case 'settings':
        return <SettingsView />;
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <ConfigBanner />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <nav
          style={{
            width: '180px',
            background: '#111',
            borderRight: '1px solid #333',
            display: 'flex',
            flexDirection: 'column',
            padding: '16px 0',
            flexShrink: 0,
          }}
        >
          <div style={{ padding: '0 16px 16px', fontWeight: 700, fontSize: '14px', color: '#a3a3a3' }}>
            {t('app.title')}
          </div>
          {NAV_ITEMS.map(({ id, key }) => (
            <button
              key={id}
              onClick={() => setActiveView(id)}
              style={{
                background: activeView === id ? '#374151' : 'transparent',
                border: 'none',
                color: activeView === id ? '#f9fafb' : '#9ca3af',
                cursor: 'pointer',
                padding: '8px 16px',
                textAlign: 'left',
                fontSize: '14px',
                borderRadius: '4px',
                margin: '2px 8px',
              }}
            >
              {t(key)}
            </button>
          ))}
        </nav>

        {/* Content area */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading && (
            <p style={{ padding: '16px', color: '#9ca3af' }}>Loading...</p>
          )}
          {error !== null && (
            <div role="alert" style={{ padding: '16px', color: '#fca5a5' }}>
              Error: {error}
            </div>
          )}
          {!loading && renderView()}
        </div>
      </div>
    </div>
  );
}
