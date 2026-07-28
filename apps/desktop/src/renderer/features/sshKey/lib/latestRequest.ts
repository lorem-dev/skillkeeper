/**
 * Tracks the latest of a series of overlapping async requests (e.g. repeated
 * `sshKeyState()` reads triggered by independent events -- mount, the
 * unlock-required event, the unlock-resolved event) so a stale response that
 * settles after a newer request already started can be ignored, instead of
 * clobbering a display with an older value.
 */
export function createLatestRequestGuard() {
  let current = 0;
  return {
    /** Call when starting a new request; returns a token to check on settle. */
    start(): number {
      return ++current;
    },
    /** Whether `token` (from `start()`) is still the most recently started
     *  request -- false once a newer one has started, whether or not it has
     *  settled yet. */
    isCurrent(token: number): boolean {
      return token === current;
    },
  };
}
