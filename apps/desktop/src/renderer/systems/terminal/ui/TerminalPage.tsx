/**
 * Full-screen embedded-terminal overlay. Open state lives in the store
 * (terminalOpen); Escape or the close button dismisses it. The xterm view is
 * mounted only while open, so a fresh Terminal instance replays the PTY's
 * retained buffer on each open.
 */
import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Icon } from '@/shared/ui';
import { fade } from '@/shared/lib';
import { TerminalView } from './TerminalView';
import './TerminalPage.scss';

export function TerminalPage() {
  const terminalOpen = useSkillkeeperStore((s) => s.terminalOpen);
  const closeTerminal = useSkillkeeperStore((s) => s.closeTerminal);
  const t = useTranslator();

  // Focus the overlay once when it opens (mirrors LogsPage).
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (terminalOpen) overlayRef.current?.focus();
  }, [terminalOpen]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') closeTerminal();
  }

  return (
    <AnimatePresence>
      {terminalOpen && (
        <motion.div
          className="sk-terminal-page"
          role="dialog"
          aria-modal="true"
          aria-label={t('terminal.title')}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          ref={overlayRef}
          variants={fade}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <header className="sk-terminal-page__header">
            <h1 className="sk-terminal-page__title">{t('terminal.title')}</h1>
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}
