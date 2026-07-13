/**
 * Bottom status bar. Holds a tasks button, a terminal button, and a bell
 * button. The tasks badge counts active (queued/running) sync tasks; the
 * bell badge counts ERRORS only (info notifications are not counted).
 * Clicking the tasks button opens the full-screen sync task list, the bell
 * opens the full-screen notifications log, the terminal button opens the
 * embedded terminal. Cross-cutting chrome -> systems/notifications.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Icon } from '@/shared/ui';
import { cx } from '@/shared/lib';
import './StatusBar.scss';

/**
 * A value that updates at most once per `ms`, on the trailing edge. A change
 * opens a window; when it elapses the value settles to whatever it is THEN, so
 * transient blips -- e.g. a task that starts and finishes within the window --
 * collapse and never flash. Used to keep the active-task badge from flickering
 * on very fast tasks.
 */
function useThrottledValue<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setThrottled(valueRef.current);
    }, ms);
  }, [value, ms]);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  return throttled;
}

/**
 * Wraps `fn` so it fires on the leading edge at most once per `ms`: the first
 * call runs immediately, and further calls within the window are dropped. Keeps
 * a rapid double/triple click from flip-flopping an overlay faster than its
 * open/close animation. The returned callback is stable; it always invokes the
 * latest `fn`.
 */
function useThrottledCallback(fn: () => void, ms: number): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastRef = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    if (now - lastRef.current < ms) return;
    lastRef.current = now;
    fnRef.current();
  }, [ms]);
}

export function StatusBar() {
  const count = useSkillkeeperStore(
    (s) => s.notifications.filter((n) => n.level === 'error').length,
  );
  const rawActiveTaskCount = useSkillkeeperStore(
    (s) => s.tasks.filter((task) => task.status === 'queued' || task.status === 'running').length,
  );
  // Throttle the displayed count so a task that runs faster than a second never
  // flashes the badge; the number settles once per second.
  const activeTaskCount = useThrottledValue(rawActiveTaskCount, 1000);
  const logsOpen = useSkillkeeperStore((s) => s.logsOpen);
  const terminalOpen = useSkillkeeperStore((s) => s.terminalOpen);
  const tasksOpen = useSkillkeeperStore((s) => s.tasksOpen);
  const openLogs = useSkillkeeperStore((s) => s.openLogs);
  const closeLogs = useSkillkeeperStore((s) => s.closeLogs);
  const openTerminal = useSkillkeeperStore((s) => s.openTerminal);
  const closeTerminal = useSkillkeeperStore((s) => s.closeTerminal);
  const openTasks = useSkillkeeperStore((s) => s.openTasks);
  const closeTasks = useSkillkeeperStore((s) => s.closeTasks);
  // Throttle the tasks toggle so a rapid re-click cannot flip the overlay
  // open/closed faster than its animation settles.
  const toggleTasks = useThrottledCallback(() => {
    if (tasksOpen) closeTasks();
    else openTasks();
  }, 500);
  const t = useTranslator();
  const label = t('statusbar.notifications', { count: String(count) });
  return (
    <footer className="sk-statusbar">
      <Button
        variant="plain"
        className={cx(
          'sk-statusbar__btn',
          'sk-statusbar__tasks',
          activeTaskCount === 0 && 'sk-statusbar__tasks--empty',
        )}
        onClick={toggleTasks}
        aria-label={t('statusbar.tasks')}
      >
        <Icon name="check" size={18} />
        {activeTaskCount > 0 && (
          <span className="sk-statusbar__badge sk-statusbar__badge--accent">{activeTaskCount}</span>
        )}
      </Button>
      <Button
        variant="plain"
        className="sk-statusbar__btn"
        onClick={terminalOpen ? closeTerminal : openTerminal}
        aria-label={t('statusbar.terminal')}
      >
        <Icon name="terminal" size={18} />
      </Button>
      <Button
        variant="plain"
        className={cx('sk-statusbar__btn', 'sk-statusbar__bell', count === 0 && 'sk-statusbar__bell--empty')}
        onClick={logsOpen ? closeLogs : openLogs}
        aria-label={label}
      >
        <Icon name="bell" size={18} />
        {count > 0 && <span className="sk-statusbar__badge">{count}</span>}
      </Button>
    </footer>
  );
}
