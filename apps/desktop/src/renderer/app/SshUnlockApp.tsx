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
  const rootRef = useRef<HTMLDivElement>(null);

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

  // Keep the window exactly as tall as this layout.
  //
  // The height cannot be picked when the window is built: the hint names the key
  // path, so it wraps over one, two or three lines depending on the path and the
  // language, and it grows again when a wrong passphrase adds an error line. A
  // fixed height was therefore either short enough to clip the buttons or tall
  // enough to leave an empty band under them.
  //
  // Observed rather than measured once, since the text arrives in stages (the
  // path from `sshKeyState`, the translations from the catalog import, the web
  // font replacing the fallback) and each stage can rewrap it. The window's
  // width never changes, so a resize cannot rewrap the text and feed itself
  // another round; the rounded-height guard keeps sub-pixel jitter from
  // resizing at all.
  //
  // Self-correcting rather than trusting one measurement, because the height
  // asked for is not the height the viewport gets: on macOS the size set for a
  // window counts its title bar, so the dialog came out exactly that bar short
  // and the buttons sat flush against the bottom edge. Each round compares what
  // was asked for against `window.innerHeight` and adds the difference back, so
  // the frame is MEASURED rather than assumed -- the same code is then correct on
  // a platform whose bar is a different height, or none of whose size includes
  // it, without a per-platform constant to keep true. DPI rounding and
  // `scrollHeight`'s missing bottom padding fall out of the same correction. It
  // settles in two rounds and then asks for nothing further.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return undefined;
    // The last height requested, and 0 before the first request -- there is no
    // shortfall to correct for until the window has answered one.
    let asked = 0;
    const sync = (): void => {
      const style = getComputedStyle(el);
      const content = Math.max(
        el.getBoundingClientRect().height,
        // `scrollHeight` rounds down and, when the content overflows, leaves out
        // the bottom padding -- add it back rather than lose the dialog's
        // bottom margin.
        el.scrollHeight + parseFloat(style.paddingBottom || '0'),
      );
      if (content === 0) return;
      const shortfall = asked > 0 ? Math.max(asked - window.innerHeight, 0) : 0;
      const target = Math.ceil(content) + shortfall;
      if (target === asked) return;
      asked = target;
      bridgeClient.fitWindowHeight(target);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    sync();
    // Every actual viewport change is a chance to see the shortfall above, and
    // the font swap rewraps every line without necessarily changing this
    // element's box, which is all a ResizeObserver would notice.
    window.addEventListener('resize', sync);
    void document.fonts?.ready.then(sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
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
    <div className="sk-ssh-unlock" ref={rootRef}>
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
