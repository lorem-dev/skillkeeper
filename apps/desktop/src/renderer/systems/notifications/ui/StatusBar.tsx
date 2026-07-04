/**
 * Bottom status bar. Holds a bell button whose badge counts ERRORS only (info
 * notifications are not counted); clicking it opens the full-screen
 * notifications log. Cross-cutting chrome -> systems/notifications.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Icon } from '@/shared/ui';
import './StatusBar.scss';

export function StatusBar() {
  const count = useSkillkeeperStore(
    (s) => s.notifications.filter((n) => n.level === 'error').length,
  );
  const openLogs = useSkillkeeperStore((s) => s.openLogs);
  const t = useTranslator();
  const label = t('statusbar.notifications', { count: String(count) });
  return (
    <footer className="sk-statusbar">
      <Button
        variant="plain"
        className={count > 0 ? 'sk-statusbar__bell' : 'sk-statusbar__bell sk-statusbar__bell--empty'}
        onClick={openLogs}
        aria-label={label}
      >
        <Icon name="bell" size={18} />
        {count > 0 && <span className="sk-statusbar__badge">{count}</span>}
      </Button>
    </footer>
  );
}
