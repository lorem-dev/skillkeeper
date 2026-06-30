import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'sk-theme';

function readPref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(pref: ThemePref): void {
  document.documentElement.setAttribute('data-theme', resolve(pref));
}

/** Theme preference, persisted to localStorage and applied via data-theme. */
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  const [pref, setPrefState] = useState<ThemePref>(readPref);

  useEffect(() => {
    apply(pref);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    localStorage.setItem(KEY, p);
    setPrefState(p);
  }, []);

  return { pref, setPref };
}
