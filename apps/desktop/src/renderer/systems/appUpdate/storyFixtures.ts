/**
 * Story-only `AppUpdateOffer` fixture, shared by every appUpdate story
 * (`UpdateAvailableDialog`, `UpdateBadge`, `UpdateReadyDialog`) and by
 * `StatusBar`'s `WithUpdate` story. Kept in one place so a new required field
 * on the DTO is one edit here instead of a silent drift across four files.
 *
 * Not used by application code -- it exists so stories stay honest.
 */
import type { AppUpdateOffer } from '@/services/bridge';

export function makeAppUpdateOffer(overrides: Partial<AppUpdateOffer> = {}): AppUpdateOffer {
  return {
    version: '1.4.2',
    bump: 'minor',
    notes: '',
    truncatedHistory: false,
    installable: true,
    showDialog: false,
    ...overrides,
  };
}
