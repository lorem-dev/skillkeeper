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
import { FormRow, Button } from '@/shared/ui';
import { sshErrorKey } from '../lib/sshErrors';
import { shouldPromptOnSelect } from '../lib/sshPrompt';
import { createLatestRequestGuard } from '../lib/latestRequest';
import './SshKeyField.scss';

/** The msgid describing a chosen key's state, or null for `notConfigured` --
 *  the "Not set" path label already says enough on its own. */
function stateMessageKey(state: SshKeyDto['state']): MessageKey | null {
  switch (state) {
    case 'notConfigured':
      return null;
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
  // (the file name identifies the key, the directories above it do not). The
  // flip is conditional: a path that fits must keep its natural order, or its
  // leading slash would flow to the far end. Only a new path can change the
  // answer, since the control's width is fixed.
  const pathRef = useRef<HTMLSpanElement>(null);
  const [pathClipped, setPathClipped] = useState(false);

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

  useEffect(() => {
    const el = pathRef.current;
    if (el === null) return;
    // Measured with the flip already applied when it is: right-to-left flow
    // does not change how wide the text is, so this cannot oscillate.
    setPathClipped(el.scrollWidth > el.clientWidth);
  }, [dto?.path]);

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

  if (dto === null) return null;

  const displayPath = dto.path ?? t('settings.ssh.notSet');
  const stateKey = stateMessageKey(dto.state);

  return (
    <FormRow
      label={t('settings.ssh.key')}
      // Two sentences, one per line: left to wrap on its own the hint breaks
      // mid-sentence at this column, which reads as an accident.
      description={
        <>
          {t('settings.ssh.keyDescription')}
          <br />
          {t('settings.ssh.keyDescriptionFallback')}
        </>
      }
      align="top"
    >
      <div className="sk-ssh-key">
        <div className="sk-ssh-key__row">
          <span
            ref={pathRef}
            className={pathClipped ? 'sk-ssh-key__path sk-ssh-key__path--clipped' : 'sk-ssh-key__path'}
            title={dto.path}
          >
            {displayPath}
          </span>
          <Button variant="secondary" loading={busy} onClick={() => void choose()}>
            {t('settings.ssh.choose')}
          </Button>
          {dto.path !== undefined && (
            <Button variant="secondary" onClick={() => void clear()}>
              {t('settings.ssh.clear')}
            </Button>
          )}
        </div>
        {/* Always rendered, even with nothing to say: the row holds its height
            so the rest of Settings does not move when a state line or its
            action appears. */}
        <div className="sk-ssh-key__row">
          <span className="sk-ssh-key__state">{stateKey !== null ? t(stateKey) : ''}</span>
          {dto.state === 'locked' && (
            <Button variant="secondary" loading={busy} onClick={() => void unlock()}>
              {t('settings.ssh.unlock')}
            </Button>
          )}
          {dto.state === 'unlocked' && (
            <Button variant="secondary" onClick={() => void forget()}>
              {t('settings.ssh.forget')}
            </Button>
          )}
        </div>
      </div>
    </FormRow>
  );
}
