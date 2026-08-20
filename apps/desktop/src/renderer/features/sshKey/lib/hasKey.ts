import type { SshKeyDto } from '@/services/bridge';

/**
 * Whether a key is actually chosen, and so whether there is anything to clear.
 *
 * Both halves matter: `notConfigured` is the backend's own word for "no key",
 * and a blank path is the same thing said differently (a hand-edited config can
 * hold an empty `sshKeyPath`). Either one must leave the clear action hidden,
 * since clearing nothing is a control that can only confuse.
 *
 * Every PuTTY state (`puttyLocked`/`puttyUnencrypted`/`puttyInAgent`/
 * `puttyNoAgent`) counts as "a key is chosen" here too -- none of them is
 * `notConfigured`, so no separate case is needed.
 */
export function hasKey(dto: SshKeyDto): boolean {
  return dto.state !== 'notConfigured' && (dto.path ?? '').trim() !== '';
}
