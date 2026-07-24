/**
 * Shared About info: the app version (fetched over the bridge), the resolved
 * dark/light flag (for the logo), the copyright year range, and the docs URL.
 * Used by AboutIdentity and AboutFooter so both the About dialog and the
 * onboarding welcome screen render the same values.
 */
import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { bridgeClient } from '@/services/bridge';

// The published docs live on GitHub Pages, versioned by mike. A release build
// links to its own version; a dev build has no published version, so it links
// to the `latest` alias.
const DOCS_BASE = 'https://lorem-dev.github.io/skillkeeper';

export interface AboutInfo {
  readonly version: string;
  readonly dark: boolean;
  readonly years: string;
  readonly docsUrl: string;
}

export function useAboutInfo(): AboutInfo {
  const theme = useSkillkeeperStore((s) => s.config?.general.theme ?? 'system');
  const [version, setVersion] = useState('');

  // Fetch the app version on mount (cheap, and keeps consumers free of any
  // lifecycle assumption about when the bridge is ready).
  useEffect(() => {
    let active = true;
    void bridgeClient.getAppVersion().then((v) => {
      if (active) setVersion(v);
    });
    return () => {
      active = false;
    };
  }, []);

  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  // Copyright years: a single "2026" while the end year is still 2026, otherwise
  // the range "2026-<end>". The end year is the build year for a production build
  // (baked via __SK_BUILD_YEAR__ at build time), or the current year in dev.
  const endYear = import.meta.env.PROD ? __SK_BUILD_YEAR__ : new Date().getFullYear();
  const years = endYear > 2026 ? `2026-${endYear}` : '2026';

  const docsVersion = import.meta.env.PROD && version !== '' ? version : 'latest';
  const docsUrl = `${DOCS_BASE}/${docsVersion}/`;

  return { version, dark, years, docsUrl };
}
