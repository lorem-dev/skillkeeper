/**
 * Root component for the SSH-unlock window (Tauri window label `ssh-unlock`).
 *
 * The backend raises this window when a user-initiated SSH operation is
 * blocked behind a locked private key. It is intentionally tiny: no store, no
 * `loadAll`, no sidebar, no terminal, no onboarding -- just the theme and the
 * translator, read once through the bridge, and a small passphrase form.
 * See `main.tsx`, which mounts this instead of `<App />` for this window's
 * label.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { createTranslatorFrom, en } from '@skillkeeper/i18n/lazy';
import type { Translator } from '@skillkeeper/i18n/lazy';
import { bridgeClient } from '@/services/bridge';
import { ensureCatalog, getCatalog, resolveLang } from '@/systems/i18n/runtime';
import { sshErrorKey } from '@/features/sshKey/lib';
import { Button, TextField } from '@/shared/ui';
import { canSubmit } from './sshUnlockState';
import './SshUnlockApp.scss';

/** Applies `theme` the same way `useTheme` does (a `data-theme` attribute on
 *  the document element), duplicated locally rather than imported: the real
 *  hook reads its preference from the Zustand store, which this window must
 *  not mount. */
function applyTheme(theme: 'system' | 'light' | 'dark'): void {
  const resolved =
    theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function SshUnlockApp() {
  const [t, setT] = useState<Translator>(() => createTranslatorFrom(en, en, 'en'));
  const [path, setPath] = useState<string | undefined>(undefined);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every failed submit (even a repeated one) so the focus-and-select
  // effect below always re-fires, regardless of whether the error message
  // itself changed.
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Theme + language, read once through the bridge -- no store, no
  // `useTheme`/`useTranslator` (both bind to the Zustand store this window
  // must not mount).
  useEffect(() => {
    let cancelled = false;
    void bridgeClient.getConfig().then(({ config }) => {
      if (cancelled) return;
      applyTheme(config.general.theme);
      const lang = resolveLang(config.general.language);
      void ensureCatalog(lang).then(() => {
        if (!cancelled) setT(() => createTranslatorFrom(getCatalog(lang), en, lang));
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The key path: seeded from `sshKeyState()` (the window may be created
  // before the backend ever emits `ssh:unlockRequired`, e.g. when raised via
  // `promptSshUnlock` right as the webview starts) and kept current by the
  // event for as long as the window stays open. Whichever settles first wins;
  // both agree once both have run.
  useEffect(() => {
    let cancelled = false;
    void bridgeClient.sshKeyState().then((dto) => {
      if (!cancelled && dto.path !== undefined) setPath(dto.path);
    });
    const off = bridgeClient.onSshUnlockRequired((p) => {
      if (!cancelled) setPath(p);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Re-focus and re-select the passphrase field after every failed attempt --
  // clicking Unlock (rather than pressing Enter) moves focus to the button,
  // so this is what brings it back for an immediate retype.
  useEffect(() => {
    if (attempt === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [attempt]);

  async function submit(): Promise<void> {
    if (!canSubmit({ passphrase, busy })) return;
    setBusy(true);
    setError(null);
    try {
      await bridgeClient.unlockSshKey(passphrase);
      bridgeClient.closeWindow();
    } catch (err) {
      const text = String(err);
      const key = sshErrorKey(text);
      setError(key !== null ? t(key) : text);
      setBusy(false);
      setAttempt((n) => n + 1);
    }
  }

  function cancel(): void {
    void bridgeClient
      .cancelSshKeyUnlock()
      // Best-effort: the window closes regardless of whether the cancel
      // command itself succeeded -- the user asked to leave.
      .catch(() => undefined)
      .finally(() => bridgeClient.closeWindow());
  }

  function onFormKeyDown(e: KeyboardEvent<HTMLFormElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  return (
    <div className="sk-ssh-unlock">
      <h1 className="sk-ssh-unlock__title">{t('ssh.unlock.title')}</h1>
      {path !== undefined && (
        <p className="sk-ssh-unlock__hint" title={path}>
          {t('ssh.unlock.hint', { path })}
        </p>
      )}
      <form
        className="sk-ssh-unlock__form"
        onKeyDown={onFormKeyDown}
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={inputRef}
          type="password"
          autoFocus
          label={t('ssh.unlock.passphrase')}
          value={passphrase}
          // Deliberately not disabled while busy: disabling would blur it (a
          // disabled control cannot hold focus), which is exactly the "keeps
          // focus" behaviour a wrong passphrase must not lose. Resubmission is
          // already blocked by the `canSubmit` guard in `submit()`, and the
          // Unlock button disables itself via its own `loading` state.
          invalid={error !== null}
          onChange={(e) => {
            setPassphrase(e.target.value);
            setError(null);
          }}
        />
        {error !== null && <p className="sk-ssh-unlock__error">{error}</p>}
        <div className="sk-ssh-unlock__actions">
          <Button type="button" variant="secondary" onClick={cancel}>
            {t('ssh.unlock.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit({ passphrase, busy })}>
            {t('ssh.unlock.submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
