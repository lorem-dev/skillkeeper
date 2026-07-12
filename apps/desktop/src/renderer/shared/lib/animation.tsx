/**
 * Global animation setting. Mirrors the `general.animations` config value so any
 * component -- including generic shared/ui ones that must not read the store --
 * can gate/scale its entrance/exit animations without a prop drilled through
 * every layer. Wrap the app in `AnimationProvider` with the current mode; read
 * `useAnimationsEnabled` (on/off) and `useAnimationScale` (a duration
 * multiplier). Components combine these with their own `animate` prop where they
 * have one.
 */
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { makeCardStagger, makeDockButton, makeDockContainer } from './transitions';

export type AnimationMode = 'fast' | 'normal' | 'off';

const AnimationContext = createContext<AnimationMode>('normal');

export function AnimationProvider({
  mode,
  children,
}: {
  readonly mode: AnimationMode;
  readonly children: ReactNode;
}) {
  return <AnimationContext.Provider value={mode}>{children}</AnimationContext.Provider>;
}

/** Whether UI entrance/exit animations play at all (mode is not 'off'). */
// eslint-disable-next-line react-refresh/only-export-components -- a hook beside its provider.
export function useAnimationsEnabled(): boolean {
  return useContext(AnimationContext) !== 'off';
}

/** Duration multiplier for animations: 0.5 in 'fast' mode (twice as quick), 1
 *  otherwise. */
// eslint-disable-next-line react-refresh/only-export-components -- a hook beside its provider.
export function useAnimationScale(): number {
  return useContext(AnimationContext) === 'fast' ? 0.5 : 1;
}

/** The shared entrance-motion variants, pre-scaled to the current speed. */
// eslint-disable-next-line react-refresh/only-export-components -- a hook beside its provider.
export function useMotion(): {
  readonly cardStagger: ReturnType<typeof makeCardStagger>;
  readonly dockButton: ReturnType<typeof makeDockButton>;
  readonly dockContainer: ReturnType<typeof makeDockContainer>;
} {
  const scale = useAnimationScale();
  return useMemo(
    () => ({
      cardStagger: makeCardStagger(scale),
      dockButton: makeDockButton(scale),
      dockContainer: makeDockContainer(scale),
    }),
    [scale],
  );
}
