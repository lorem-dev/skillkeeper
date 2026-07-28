/**
 * Settings row for choosing the private SSH key used for SSH remotes. Reads
 * and writes the backend's in-memory key store through the typed bridge
 * client -- the renderer never verifies a passphrase or touches the key file
 * itself. Local component state only: nothing else in the app reads it.
 */
import { useEffect, useState } from 'react';
import type { MessageKey } from '@skillkeeper/i18n';
import { bridgeClient } from '@/services/bridge';
import type { SshKeyDto } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { FormRow, Button } from '@/shared/ui';
import { sshErrorKey } from '../lib/sshErrors';
import { shouldPromptOnSelect } from '../lib/sshPrompt';
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

  useEffect(() => {
    void bridgeClient.sshKeyState().then(setDto);
  }, []);

  // A blocked git operation elsewhere (e.g. a repository sync) can raise the
  // unlock window while this page happens to be open; refresh so the state
  // line does not go stale until the user navigates back to Settings.
  useEffect(
    () => bridgeClient.onSshUnlockRequired(() => void bridgeClient.sshKeyState().then(setDto)),
    [],
  );

  // The prompt this row raises (or joins) resolves in its own window, so this
  // is the only way the row learns it is over -- re-read the state rather
  // than trusting the payload, so the row settles to "Unlocked for this
  // session" on success or back to "Locked" on cancel/close either way.
  useEffect(
    () => bridgeClient.onSshUnlockResolved(() => void bridgeClient.sshKeyState().then(setDto)),
    [],
  );

  // ssh_key_select/clear/forget reject with a raw backend error string (unlike
  // the RepoResult-shaped calls) -- map through sshErrorKey so a known code
  // still translates, exactly like the clone/sync notify path in store.ts.
  function reportFailure(error: unknown): void {
    const text = String(error);
    const key = sshErrorKey(text);
    notify(key !== null ? { key } : text, 'error');
  }

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
    const path = await bridgeClient.pickSshKeyFile();
    if (path === null) return;
    try {
      const next = await bridgeClient.selectSshKey(path);
      setDto(next);
      // A freshly-chosen encrypted key: ask now, while the user is still
      // here, rather than waiting for the next clone/sync to ask for it.
      if (shouldPromptOnSelect(next.state)) await promptUnlock();
    } catch (error) {
      reportFailure(error);
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
    <FormRow label={t('settings.ssh.key')} description={t('settings.ssh.keyDescription')} align="top">
      <div className="sk-ssh-key">
        <div className="sk-ssh-key__row">
          <span className="sk-ssh-key__path" title={dto.path}>
            {displayPath}
          </span>
          <Button variant="secondary" onClick={() => void choose()}>
            {t('settings.ssh.choose')}
          </Button>
          {dto.path !== undefined && (
            <Button variant="secondary" onClick={() => void clear()}>
              {t('settings.ssh.clear')}
            </Button>
          )}
        </div>
        {stateKey !== null && (
          <div className="sk-ssh-key__row">
            <span className="sk-ssh-key__state">{t(stateKey)}</span>
            {dto.state === 'locked' && (
              <Button variant="secondary" onClick={() => void promptUnlock()}>
                {t('settings.ssh.unlock')}
              </Button>
            )}
            {dto.state === 'unlocked' && (
              <Button variant="secondary" onClick={() => void forget()}>
                {t('settings.ssh.forget')}
              </Button>
            )}
          </div>
        )}
      </div>
    </FormRow>
  );
}
