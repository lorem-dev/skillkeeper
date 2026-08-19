import type { MessageKey } from '@skillkeeper/i18n';

/** Backend error codes that carry a translatable message, not git output. */
const SSH_ERROR_KEYS = [
  'ssh.keyLocked',
  'ssh.keyMissing',
  'ssh.notAPrivateKey',
  'ssh.hostKeyPrompt',
  'ssh.wrongPassphrase',
  'ssh.askpassUnavailable',
  'ssh.askpassExpired',
  'ssh.askpassStale',
  'ssh.askpassForgotten',
  'ssh.puttyNeedsAgent',
  'ssh.puttyUnsupportedAlgorithm',
  'ssh.puttyDamaged',
  'ssh.puttyExportFailed',
] as const satisfies readonly MessageKey[];

/**
 * Turn a backend error into a message key, or null when it is raw git text.
 * Repository errors reach the notification log as-is, so only these known codes
 * may be translated -- anything else is shown verbatim.
 */
export function sshErrorKey(error: string): MessageKey | null {
  return (SSH_ERROR_KEYS as readonly string[]).includes(error) ? (error as MessageKey) : null;
}
