/**
 * About dialog: wraps AboutContent (logo, name, version, tagline, and
 * copyright) in the shared Modal. Opened from the application menu's About
 * item (bridgeClient.onMenuAbout, subscribed in App.tsx) via the store's
 * aboutOpen/openAbout/closeAbout, mirroring the logs/terminal/tasks overlay
 * pattern.
 */
import { Modal } from '@/shared/ui';
import { useSkillkeeperStore } from '@/app/store';
import { AboutContent } from './AboutContent';
import './AboutDialog.scss';

export function AboutDialog() {
  const open = useSkillkeeperStore((s) => s.aboutOpen);
  const closeAbout = useSkillkeeperStore((s) => s.closeAbout);

  return (
    <Modal open={open} onClose={closeAbout} className="sk-about">
      <AboutContent />
    </Modal>
  );
}
