/**
 * Status-bar badge for the self-update flow: the offered version while idle,
 * or the download percentage while a download is in flight (see `badgeState`
 * for the precedence/clamping rules -- this component only renders what that
 * function decides). Hidden entirely when there is nothing installable on
 * offer. Clicking it while idle reopens the "update available" dialog
 * (dismissing it does not forget the offer); disabled while downloading,
 * since there is nothing to act on until the download settles.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button } from '@/shared/ui';
import { badgeState } from '../model';
import './UpdateBadge.scss';

export function UpdateBadge() {
  const offer = useSkillkeeperStore((s) => s.appUpdate.offer);
  const downloading = useSkillkeeperStore((s) => s.appUpdate.downloading);
  const percent = useSkillkeeperStore((s) => s.appUpdate.percent);
  const openAppUpdateAvailable = useSkillkeeperStore((s) => s.openAppUpdateAvailable);
  const t = useTranslator();

  const state = badgeState(offer, downloading, percent);
  if (state.kind === 'hidden') return null;

  const label =
    state.kind === 'downloading'
      ? t('appUpdate.badgeProgress', { percent: String(state.percent) })
      : t('appUpdate.badge', { version: state.version });

  return (
    <Button
      variant="tinted"
      disabled={state.kind === 'downloading'}
      className="sk-update-badge"
      onClick={openAppUpdateAvailable}
      title={label}
    >
      <span className="sk-update-badge__label">{label}</span>
    </Button>
  );
}
