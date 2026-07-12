/**
 * Global animation toggle. Mirrors the `general.animations` config setting so
 * any component -- including generic shared/ui ones that must not read the store
 * -- can gate its entrance/exit animations without a prop drilled through every
 * layer. Wrap the app in `AnimationProvider` with the current setting; read it
 * with `useAnimationsEnabled`. Individual components may still take their own
 * `animate` prop and combine it with this (e.g. `animate && useAnimationsEnabled()`).
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const AnimationContext = createContext(true);

export function AnimationProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return <AnimationContext.Provider value={enabled}>{children}</AnimationContext.Provider>;
}

/** Whether UI entrance/exit animations are enabled (the global setting). */
// eslint-disable-next-line react-refresh/only-export-components -- a hook beside its provider.
export function useAnimationsEnabled(): boolean {
  return useContext(AnimationContext);
}
