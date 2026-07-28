/**
 * Pure submit-gating logic for the SSH unlock window. Kept separate from
 * `SshUnlockApp.tsx` so it is testable without React or the Tauri bridge.
 */
export interface UnlockFormState {
  readonly passphrase: string;
  readonly busy: boolean;
}

/** Whether Unlock is actionable: something typed, nothing in flight. */
export function canSubmit({ passphrase, busy }: UnlockFormState): boolean {
  return passphrase.length > 0 && !busy;
}
