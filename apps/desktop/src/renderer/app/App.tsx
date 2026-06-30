/**
 * Root application component.
 *
 * Renders: a sidebar for navigation, the config-validity banner, and a
 * placeholder content area that shows the selected view. No router library is
 * used for the v1 shell -- a simple useState drives view selection.
 */
import { useState, useEffect } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { ConfigBanner } from '@/features/configBanner';
import { RepositoriesPage } from '@/pages/Repositories';
import { SkillsPage } from '@/pages/Skills';
import { ProjectsPage } from '@/pages/Projects';
import { SettingsPage } from '@/pages/Settings';
import { Spinner } from '@/shared/ui';
import { cx } from '@/shared/lib';
import './App.scss';

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
        return <RepositoriesPage />;
      case 'skills':
        return <SkillsPage />;
      case 'projects':
        return <ProjectsPage />;
      case 'settings':
        return <SettingsPage />;
    }
  }

  return (
    <div className="sk-app">
      <ConfigBanner />
      <div className="sk-shell">
        <nav className="sk-sidebar">
          <div className="sk-sidebar__title">{t('app.title')}</div>
          <div className="sk-nav">
            {NAV_ITEMS.map(({ id, key }) => (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className={cx('sk-nav-item', activeView === id && 'sk-nav-item--active')}
                aria-current={activeView === id ? 'page' : undefined}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </nav>

        <div className="sk-content">
          {loading && (
            <div className="sk-state">
              <Spinner label={t('common.loading')} />
            </div>
          )}
          {error !== null && (
            <div role="alert" className="sk-state sk-state--error">
              {t('common.errorPrefix', { message: error })}
            </div>
          )}
          {!loading && renderView()}
        </div>
      </div>
    </div>
  );
}
