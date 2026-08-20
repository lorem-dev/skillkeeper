import type { SshKeyDto } from '@/services/bridge';

/**
 * Whether choosing a new key should immediately ask the backend to raise the
 * unlock prompt (`promptSshUnlock`), so the passphrase is verified while the
 * user is still in Settings rather than at the next clone/sync.
 *
 * Only a freshly-chosen encrypted key needs this: `unlocked`/`unencrypted`/
 * `notConfigured` have nothing to ask about, and `missing`/`notAKey` have no
 * window to raise for them either -- `promptSshUnlock` would only report the
 * same code `selectSshKey` already surfaced.
 *
 * Of the PuTTY states, only `puttyLocked` prompts, for the same reason:
 * `puttyUnencrypted` has no passphrase to ask for, `puttyInAgent` has already
 * been loaded and dealt with, and `puttyNoAgent` is a missing ssh-agent, not
 * a passphrase -- a prompt would not fix that.
 */
export function shouldPromptOnSelect(state: SshKeyDto['state']): boolean {
  return state === 'locked' || state === 'puttyLocked';
}
