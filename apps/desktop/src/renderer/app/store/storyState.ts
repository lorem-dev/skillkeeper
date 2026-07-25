/**
 * Story-only store helpers.
 *
 * The store is a module-level singleton shared by every story in a Storybook
 * session, and stories seed it by mutation. Two things then go wrong:
 *
 * - **Leakage.** A story that sets only the slices it cares about inherits
 *   whatever a previously-viewed story left in the others, so what you see
 *   depends on your click path. Notifications were the visible case (errors
 *   seeded by one story made the next story's warning badge render red, because
 *   errors outrank warnings), but any slice a story reads without seeding has the
 *   same problem: leftover `projects`, `mcpInstalls`, a stale `mcpUi.query` that
 *   silently filters a tree, and so on.
 * - **Double seeding.** React re-invokes effects in development, so an appending
 *   seed (`notify`, `notifyResolveWarnings`) runs twice and doubles its counts.
 *
 * Resetting to the store's initial state first fixes both: every story becomes
 * order-independent and its seed idempotent.
 *
 * Not used by application code -- it exists so stories stay honest.
 */
import { useSkillkeeperStore } from './index';

/**
 * Reset the whole store to its initial state, then run `seed`.
 *
 * The reset replaces rather than merges, which is why it restores the actions
 * too: zustand's initial state is the object the creator returned, state and
 * actions together.
 */
export function seedStore(seed: () => void): void {
  useSkillkeeperStore.setState(useSkillkeeperStore.getInitialState(), true);
  seed();
}
