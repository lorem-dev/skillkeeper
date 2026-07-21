/**
 * Full-screen embedded-terminal overlay. Open state lives in the store
 * (terminalOpen); Escape or the close button dismisses it.
 *
 * The xterm view stays MOUNTED even while the overlay is hidden (we toggle
 * opacity, not mount) and the container keeps its full size, so the PTY is
 * always sized to the window. That keeps the PTY width equal to what the user
 * sees, so a command run in the background renders at the same width it is later
 * viewed at -- the shell's line-editor repaints line up instead of overlapping.
 */
import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Icon } from '@/shared/ui';
import { cx, dragRegion } from '@/shared/lib';
import { TerminalView } from './TerminalView';
import './TerminalPage.scss';

export function TerminalPage() {
  const terminalOpen = useSkillkeeperStore((s) => s.terminalOpen);
  const closeTerminal = useSkillkeeperStore((s) => s.closeTerminal);
  const t = useTranslator();

  // Focus the overlay each time it opens (mirrors LogsPage).
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (terminalOpen) overlayRef.current?.focus();
  }, [terminalOpen]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') closeTerminal();
  }

  return (
    <div
      className={cx('sk-terminal-page', !terminalOpen && 'sk-terminal-page--hidden')}
      role="dialog"
      aria-modal="true"
      aria-label={t('terminal.title')}
      aria-hidden={!terminalOpen}
      inert={!terminalOpen}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      ref={overlayRef}
    >
      <header className="sk-terminal-page__header" {...dragRegion({ always: true })}>
        <h1 className="sk-terminal-page__title" {...dragRegion({ always: true })}>
          {t('terminal.title')}
        </h1>
        <Button
          variant="plain"
          className="sk-terminal-page__close"
          onClick={closeTerminal}
          aria-label={t('common.close')}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="sk-terminal-page__body">
        <TerminalView />
      </div>
    </div>
  );
}
