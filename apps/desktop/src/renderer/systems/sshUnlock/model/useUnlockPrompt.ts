/**
 * Whether the SSH passphrase prompt is on screen right now.
 *
 * The prompt lives in its own window, so nothing in this one can observe it
 * directly -- the backend's two app-wide events are the whole story:
 * `ssh:unlockRequired` when a prompt is raised (or an operation joins the one
 * already up), and `ssh:unlockResolved` exactly once per resolution, however
 * the prompt ends (a verified passphrase, Cancel, or the window closing). That
 * "exactly once, on every path" guarantee is what makes a flag driven by them
 * safe to block the whole app behind.
 *
 * Deliberately not seeded from `sshKeyState()`: a locked key does not mean a
 * prompt is up, and there is no state to read that would say otherwise.
 */
import { useEffect, useState } from 'react';
import { bridgeClient } from '@/services/bridge';

export function useUnlockPromptOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => bridgeClient.onSshUnlockRequired(() => setOpen(true)), []);
  useEffect(() => bridgeClient.onSshUnlockResolved(() => setOpen(false)), []);

  return open;
}
