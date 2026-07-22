import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';

/**
 * The resolved dark-appearance flag, reactive to both inputs that decide it:
 * the theme preference (`config.general.theme`, via the store) and -- when that
 * preference is "system" -- the OS appearance (via a `prefers-color-scheme`
 * listener). Unlike reading `data-theme` once, this re-renders the consumer when
 * either input changes, so always-visible chrome (e.g. the title bar brand mark)
 * tracks live theme switches.
 */
export function useIsDark(): boolean {
  const pref = useSkillkeeperStore((s) => s.config?.general.theme ?? 'system');
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return pref === 'dark' || (pref === 'system' && systemDark);
}
