import { useEffect } from 'react';
import { useSkillkeeperStore } from '@/app/store';

export type ThemePref = 'system' | 'light' | 'dark';

function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Theme preference, read from and written to the config file (config.general.theme).
 * Applies the resolved theme via data-theme on the document element.
 */
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  const pref = useSkillkeeperStore((s) => s.config?.general.theme ?? 'system');
  const updateConfig = useSkillkeeperStore((s) => s.updateConfig);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolve(pref));
  }, [pref]);

  const setPref = (p: ThemePref): void => {
    void updateConfig({ general: { theme: p } });
  };

  return { pref, setPref };
}
