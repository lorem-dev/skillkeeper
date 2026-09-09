import { useEffect, useRef, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { deriveRepoName, MAX_REPO_NAME_LENGTH } from '@/entities/repository';
import { resolveNotification } from '@/systems/notifications';
import { Button, Modal, TextField } from '@/shared/ui';
import { asSchemeUrl, scpPortMistake } from '../lib/remoteHint';
import { newestErrorSince } from '../lib/notificationCutoff';
import './RepoAddButton.scss';

/**
 * Minimal remote-URL check: accept https/http/git/ssh URLs and scp-style
 * `user@host:path`. Not a security boundary (the shell values are escaped where
 * git runs) -- just guards against obviously wrong input in the form.
 */
function isValidRemote(url: string): boolean {
  const u = url.trim();
  return /^(?:https?|git|ssh):\/\/[^\s]+$/i.test(u) || /^[\w.+-]+@[\w.-]+:[^\s]+$/i.test(u);
}

export function RepoAddButton() {
  const t = useTranslator();
  const addRepository = useSkillkeeperStore((s) => s.addRepository);
  const addRepoRequest = useSkillkeeperStore((s) => s.addRepoRequest);
  const clearAddRepoRequest = useSkillkeeperStore((s) => s.clearAddRepoRequest);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Set only when `addRepository` itself failed (the `repositories_add`
  // command, before any row could exist) -- a clone failure that happens
  // AFTER the repository record was created leaves the row in place with its
  // own error indicator instead (see RepositoryCard's error dot), and this
  // form has already closed by then.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Bumped on cancel/reopen so a submit's `.then`/`.catch` -- resolving after
  // the user has already dismissed or restarted the form -- never applies its
  // (now stale) outcome to a different attempt's state.
  const submitToken = useRef(0);

  const reset = (): void => {
    setUrl('');
    setName('');
    setNameEdited(false);
    setSubmitError(null);
  };

  // Open prefilled when another page requests adding a repo (e.g. an unlinked
  // skill supplying its remote), then consume the request.
  useEffect(() => {
    if (addRepoRequest === null) return;
    setUrl(addRepoRequest);
    setName(deriveRepoName(addRepoRequest));
    setNameEdited(false);
    setOpen(true);
    clearAddRepoRequest();
  }, [addRepoRequest, clearAddRepoRequest]);

  const cancel = (): void => {
    submitToken.current += 1;
    setOpen(false);
    setSubmitting(false);
    reset();
  };

  const onUrlChange = (value: string): void => {
    setUrl(value);
    setSubmitError(null);
    if (!nameEdited) setName(deriveRepoName(value));
  };

  const valid = isValidRemote(url);
  // Accepted by git and by the check above, but the port in it is silently a
  // path: worth saying so here rather than leaving a public-key refusal later.
  const portIgnored = scpPortMistake(url);
  const showError = url.trim() !== '' && !valid;

  const submit = (): void => {
    if (!valid || submitting) return;
    const trimmedUrl = url.trim();
    const trimmedName = name.trim();
    const token = (submitToken.current += 1);
    setSubmitting(true);
    setSubmitError(null);
    // `addRepository` (app/store/store.ts) chains add -> clone -> describe and
    // never rejects on a backend failure -- it calls `notify` and resolves.
    // The only way to tell success from an add-level failure back here is to
    // check, once it settles, whether a row for THIS submit actually landed:
    // `notify`'s `set()` calls happen synchronously inside that same async
    // chain, so by the time this await resolves the store already reflects
    // the outcome. Matching by url ALONE is not enough -- a "duplicate" add
    // failure (the real backend's answer for a URL already tracked, see
    // `add` in `apps/desktop/src-tauri/src/commands/repositories.rs`) leaves
    // a pre-existing row with that same url in place, which a bare url match
    // would misread as this submit's own success. Snapshotting the ids
    // present before the call and requiring the matched row's id to be NEW
    // rules that out.
    const idsBefore = new Set(useSkillkeeperStore.getState().repositories.map((r) => r.id));
    // The id of the newest notification logged so far, not the log's length:
    // `notify` (`app/store/store.ts`) caps the log at `NOTIFICATION_LOG_LIMIT`
    // (500), so once it is full the array's length stays put while entries
    // shift left as new ones are appended -- a length snapshot would then read
    // back an empty slice for a genuinely new entry (see `newestErrorSince`'s
    // doc comment). Anchoring on this entry's id survives that shift.
    const lastNotificationIdBefore = useSkillkeeperStore.getState().notifications.at(-1)?.id;
    void addRepository(trimmedUrl, trimmedName)
      .then(() => {
        // The user cancelled or restarted the form before this settled --
        // applying its outcome now would stomp a different attempt's state.
        if (submitToken.current !== token) return;
        const state = useSkillkeeperStore.getState();
        const wasAdded = state.repositories.some((r) => r.url === trimmedUrl && !idsBefore.has(r.id));
        setSubmitting(false);
        if (wasAdded) {
          setOpen(false);
          reset();
          return;
        }
        // Not added: the failure is the newest error `notify`d since this
        // submit started (the add call notifies with the raw backend error,
        // never a rejection -- see the comment above).
        const failure = newestErrorSince(state.notifications, lastNotificationIdBefore);
        setSubmitError(failure !== undefined ? resolveNotification(failure, t) : '');
      })
      .catch((err: unknown) => {
        if (submitToken.current !== token) return;
        setSubmitting(false);
        setSubmitError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <>
      <Button variant="primary" glass loading={open} data-testid="repo-add-button" onClick={() => setOpen(true)}>
        {t('repositories.add')}
      </Button>
      <Modal open={open} onClose={cancel} title={t('repositories.add')}>
        <div className="sk-repo-form" data-testid="repo-add-form">
          <TextField
            data-testid="repo-add-url"
            placeholder={t('repositories.addRemote')}
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
          />
          {showError && <p className="sk-repo-form__error">{t('repositories.invalidRemote')}</p>}
          {!showError && portIgnored && (
            <p className="sk-repo-form__error">{t('repositories.scpPortIgnored', { url: asSchemeUrl(url) })}</p>
          )}
          <TextField
            placeholder={t('repositories.addName')}
            value={name}
            maxLength={MAX_REPO_NAME_LENGTH}
            onChange={(e) => {
              setNameEdited(true);
              setName(e.target.value);
            }}
          />
          {submitError !== null && (
            <p className="sk-repo-form__error" data-testid="repo-add-error">
              {submitError}
            </p>
          )}
          <div className="sk-repo-form__actions">
            <Button variant="secondary" onClick={cancel}>
              {t('common.close')}
            </Button>
            <Button variant="primary" data-testid="repo-add-submit" onClick={submit} disabled={!valid || submitting}>
              {t('repositories.add')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
