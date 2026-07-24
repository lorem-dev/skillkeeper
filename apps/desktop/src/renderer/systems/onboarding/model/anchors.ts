import { useCallback } from 'react';
import type { AnchorId } from './steps';

const registry = new Map<AnchorId, HTMLElement>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

/** Register (or clear, with null) an anchor element. Exported for tests. */
export function __registerAnchor(id: AnchorId, el: HTMLElement | null): void {
  if (el === null) registry.delete(id);
  else registry.set(id, el);
  notify();
}

export function getAnchorElement(id: AnchorId): HTMLElement | null {
  return registry.get(id) ?? null;
}

export function subscribeAnchors(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Returns a ref callback for a page/feature to tag its onboarding target. */
export function useOnboardingAnchor(id: AnchorId): (el: HTMLElement | null) => void {
  return useCallback((el: HTMLElement | null) => __registerAnchor(id, el), [id]);
}
