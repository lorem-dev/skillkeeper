/**
 * Staging for a "show a skeleton, don't flash" load: given whether the content
 * is `ready`, decide whether to show a loading skeleton or the content.
 *
 *  - Content ready within `delayMs` (default 50): show it straight away -- a
 *    quick load never flashes a skeleton.
 *  - Not ready by `delayMs`: show the skeleton, and hold it at least `minHoldMs`
 *    (default 500) before the content, so the skeleton itself never flickers.
 *  - `enabled: false` (e.g. animations off): no staging at all -- show the
 *    content as soon as it is ready, never a skeleton.
 *
 * The brief pre-skeleton window (not ready, under `delayMs`) reports neither, so
 * the caller can render nothing for that sub-frame.
 */
import { useEffect, useRef, useState } from 'react';

export interface SkeletonStage {
  readonly showSkeleton: boolean;
  readonly showContent: boolean;
}

export interface SkeletonStageOptions {
  readonly delayMs?: number;
  readonly minHoldMs?: number;
  readonly enabled?: boolean;
}

export function useSkeletonStage(ready: boolean, options: SkeletonStageOptions = {}): SkeletonStage {
  const { delayMs = 50, minHoldMs = 500, enabled = true } = options;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = setTimeout(() => {
      if (!readyRef.current) setShowSkeleton(true);
    }, delayMs);
    return () => clearTimeout(id);
  }, [enabled, delayMs]);

  useEffect(() => {
    if (!showSkeleton) return undefined;
    const id = setTimeout(() => setHeld(true), minHoldMs);
    return () => clearTimeout(id);
  }, [showSkeleton, minHoldMs]);

  if (!enabled) return { showSkeleton: false, showContent: ready };
  const showContent = ready && (!showSkeleton || held);
  return { showSkeleton: showSkeleton && !showContent, showContent };
}
