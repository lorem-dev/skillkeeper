/**
 * Settings row for choosing the private SSH key used for SSH remotes. Reads
 * and writes the backend's in-memory key store through the typed bridge
 * client -- the renderer never verifies a passphrase or touches the key file
 * itself. Local component state only: nothing else in the app reads it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from '@skillkeeper/i18n';
import { bridgeClient } from '@/services/bridge';
import type { SshKeyDto } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { FormRow, Button, Icon, Tooltip } from '@/shared/ui';
import { sshErrorKey } from '../lib/sshErrors';
import { shouldPromptOnSelect } from '../lib/sshPrompt';
import { createLatestRequestGuard } from '../lib/latestRequest';
import { clipHead } from '../lib/clipHead';
import { hasKey } from '../lib/hasKey';
import './SshKeyField.scss';

/** The msgid for the line under the actions: what the chosen key's state is, or,
 *  with no key chosen, what happens instead. That sentence used to sit in the
 *  row's description, where it read as a caveat about a setting the user had not
 *  made yet; under the button it answers the question the empty row raises. */
function stateMessageKey(state: SshKeyDto['state']): MessageKey {
  switch (state) {
    case 'notConfigured':
      return 'settings.ssh.keyDescriptionFallback';
    case 'missing':
      return 'settings.ssh.state.missing';
    case 'notAKey':
      return 'settings.ssh.state.notAKey';
    case 'unencrypted':
      return 'settings.ssh.state.plain';
    case 'locked':
      return 'settings.ssh.state.locked';
    case 'unlocked':
      return 'settings.ssh.state.unlocked';
    case 'puttyLocked':
      return 'settings.ssh.state.puttyLocked';
    case 'puttyUnencrypted':
      return 'settings.ssh.state.puttyUnencrypted';
    case 'puttyInAgent':
      return 'settings.ssh.state.puttyInAgent';
    case 'puttyNoAgent':
      return 'settings.ssh.state.puttyNoAgent';
  }
}

export function SshKeyField() {
  const t = useTranslator();
  const notify = useSkillkeeperStore((s) => s.notify);
  const [dto, setDto] = useState<SshKeyDto | null>(null);
  // Guards Choose and Unlock: both raise a native window (a file picker, or
  // the unlock prompt) and a double-click must not raise a second one, so
  // both are disabled for the duration of whichever is running.
  const [busy, setBusy] = useState(false);
  // Mount, the unlock-required event, and the unlock-resolved event each
  // trigger their own `sshKeyState()` read; two can be in flight together
  // (e.g. a resolve arriving just after mount), and nothing guarantees they
  // settle in the order they started. The guard lets a stale settle be
  // ignored instead of clobbering the row with an older value.
  // `useRef`'s initializer only matters on the first render (later calls are
  // discarded), so the guard is constructed once despite the plain argument.
  const requestGuard = useRef(createLatestRequestGuard());
  // A path too long for the control is cut at its head rather than its tail
  // (the file name identifies the key, the directories above it do not), which
  // takes measuring the rendered text. Only a new path can change the answer,
  // since the control's width is fixed.
  const pathRef = useRef<HTMLSpanElement>(null);
  const [shownPath, setShownPath] = useState<string | null>(null);

  // ssh_key_select/clear/forget/prompt reject with a raw backend error string
  // (unlike the RepoResult-shaped calls) -- map through sshErrorKey so a
  // known code still translates, exactly like the clone/sync notify path in
  // store.ts. `notify` is a stable store-action reference, so this identity
  // never actually changes -- wrapped in `useCallback` only so `refreshState`
  // below can declare it as a dependency.
  const reportFailure = useCallback(
    (error: unknown) => {
      const text = String(error);
      const key = sshErrorKey(text);
      notify(key !== null ? { key } : text, 'error');
    },
    [notify],
  );

  // Re-reads `sshKeyState()` under the request guard, so a settle that is no
  // longer the latest request is silently dropped (neither applied nor
  // reported) rather than clobbering the row or double-reporting a failure
  // two overlapping reads both hit.
  const refreshState = useCallback(() => {
    const guard = requestGuard.current;
    const token = guard.start();
    bridgeClient
      .sshKeyState()
      .then((next) => {
        if (guard.isCurrent(token)) setDto(next);
      })
      .catch((error: unknown) => {
        if (guard.isCurrent(token)) reportFailure(error);
      });
  }, [reportFailure]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const path = dto?.path;
  useEffect(() => {
    const el = pathRef.current;
    if (el === null || path === undefined) {
      setShownPath(null);
      return;
    }
    // Measured against the element's own font, so the result matches what the
    // control will actually render. Measuring rather than mutating the DOM keeps
    // this off React's rendering path.
    const style = window.getComputedStyle(el);
    const context = document.createElement('canvas').getContext('2d');
    if (context === null) {
      setShownPath(null);
      return;
    }
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    setShownPath(clipHead(path, el.clientWidth, (text) => context.measureText(text).width));
  }, [path]);

  // A blocked git operation elsewhere (e.g. a repository sync) can raise the
  // unlock window while this page happens to be open; refresh so the state
  // line does not go stale until the user navigates back to Settings.
  useEffect(
    () => bridgeClient.onSshUnlockRequired(() => refreshState()),
    [refreshState],
  );

  // The prompt this row raises (or joins) resolves in its own window, so this
  // is the only way the row learns it is over -- re-read the state rather
  // than trusting the payload, so the row settles to "Unlocked for this
  // session" on success or back to "Locked" on cancel/close either way.
  useEffect(
    () => bridgeClient.onSshUnlockResolved(() => refreshState()),
    [refreshState],
  );

  // Raises the unlock window on demand (or joins the one a blocked git
  // operation is already waiting behind) and returns as soon as it is up --
  // it does not itself unlock anything. The row learns the outcome from
  // `onSshUnlockResolved` above, which re-reads the state once the prompt
  // resolves.
  async function promptUnlock(): Promise<void> {
    try {
      await bridgeClient.promptSshUnlock();
    } catch (error) {
      reportFailure(error);
    }
  }

  async function choose(): Promise<void> {
    setBusy(true);
    try {
      const path = await bridgeClient.pickSshKeyFile();
      if (path === null) return;
      const next = await bridgeClient.selectSshKey(path);
      setDto(next);
      // A freshly-chosen encrypted key: ask now, while the user is still
      // here, rather than waiting for the next clone/sync to ask for it.
      if (shouldPromptOnSelect(next.state)) await promptUnlock();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function unlock(): Promise<void> {
    setBusy(true);
    try {
      await promptUnlock();
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    try {
      setDto(await bridgeClient.clearSshKey());
    } catch (error) {
      reportFailure(error);
    }
  }

  async function forget(): Promise<void> {
    try {
      await bridgeClient.forgetSshKey();
      setDto(await bridgeClient.sshKeyState());
    } catch (error) {
      reportFailure(error);
    }
  }

  // Picks a destination and hands it to the backend. An encrypted key then
  // raises the unlock window for its passphrase, and the row settles on the new
  // OpenSSH path through the existing `onSshUnlockResolved` effect -- exactly
  // the path an ordinary unlock takes, which is why there is no passphrase
  // handling here.
  async function convertKey(): Promise<void> {
    setBusy(true);
    try {
      const dest = await bridgeClient.saveSshKeyFile();
      if (dest === null) return;
      setDto(await bridgeClient.beginSshKeyExport(dest));
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(false);
    }
  }

  if (dto === null) return null;

  const displayPath = shownPath ?? dto.path ?? t('settings.ssh.notSet');
  const stateKey = stateMessageKey(dto.state);
  // Shown for any PuTTY key that is not already usable through an agent:
  // `puttyInAgent` needs nothing to work right now, so there is nothing to
  // offer for it here. The command itself accepts that state -- a git
  // operation can load the key between this render and the click, and a
  // conversion asked for a moment earlier must not then be refused.
  const isPutty =
    dto.state === 'puttyLocked' ||
    dto.state === 'puttyUnencrypted' ||
    dto.state === 'puttyNoAgent';

  return (
    <FormRow
      label={t('settings.ssh.key')}
      description={t('settings.ssh.keyDescription')}
      align="top"
    >
      <div className="sk-ssh-key">
        <div className="sk-ssh-key__row">
          <span ref={pathRef} className="sk-ssh-key__path" title={dto.path}>
            {displayPath}
          </span>
          {/* One joined group: the choose/clear action and, when there is a
              passphrase to hold, the padlock. Choosing and clearing are the
              same slot rather than two buttons: with a key already set there is
              nothing to choose until it is cleared, so offering both left one
              of them inert. The padlock is an icon with a tooltip, since it
              toggles rather than names an action. */}
          <div className="sk-ssh-key__actions">
            {hasKey(dto) ? (
              <Button variant="secondary" onClick={() => void clear()}>
                {t('settings.ssh.clear')}
              </Button>
            ) : (
              <Button variant="secondary" loading={busy} onClick={() => void choose()}>
                {t('settings.ssh.choose')}
              </Button>
            )}
            {(dto.state === 'locked' || dto.state === 'puttyLocked') && (
              <Tooltip content={t('settings.ssh.unlock')}>
                <Button
                  variant="secondary"
                  className="sk-ssh-key__icon-btn"
                  loading={busy}
                  aria-label={t('settings.ssh.unlock')}
                  onClick={() => void unlock()}
                >
                  <Icon name="lock" size={16} />
                </Button>
              </Tooltip>
            )}
            {(dto.state === 'unlocked' || dto.state === 'puttyInAgent') && (
              <Tooltip content={t('settings.ssh.forget')}>
                <Button
                  variant="secondary"
                  className="sk-ssh-key__icon-btn"
                  aria-label={t('settings.ssh.forget')}
                  onClick={() => void forget()}
                >
                  <Icon name="unlock" size={16} />
                </Button>
              </Tooltip>
            )}
            {isPutty && (
              <Button variant="secondary" loading={busy} onClick={() => void convertKey()}>
                {t('settings.ssh.convert')}
              </Button>
            )}
          </div>
        </div>
        {/* Always rendered, even with nothing to say: the row holds its height
            so the rest of Settings does not move when a state line appears. */}
        <div className="sk-ssh-key__row">
          <span className="sk-ssh-key__state">{t(stateKey)}</span>
        </div>
      </div>
    </FormRow>
  );
}
