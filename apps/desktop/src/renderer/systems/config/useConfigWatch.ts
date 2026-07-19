import { useEffect } from 'react';
import { bridgeClient } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';

/**
 * Subscribes to config-file changes pushed by the Rust backend and applies each
 * reloaded result to the store, so the UI reflects external edits within ~1s.
 */
export function useConfigWatch(): void {
  const setConfig = useSkillkeeperStore((s) => s.setConfig);
  useEffect(() => {
    const unsubscribe = bridgeClient.onConfigChanged((result) => {
      setConfig(result.config, result.validity, result.warnings);
    });
    return unsubscribe;
  }, [setConfig]);
}
