import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { deriveRepoName, MAX_REPO_NAME_LENGTH } from '@/entities/repository';
import { Button, Modal, TextField } from '@/shared/ui';
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

  const reset = (): void => {
    setUrl('');
    setName('');
    setNameEdited(false);
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
    setOpen(false);
    reset();
  };

  const onUrlChange = (value: string): void => {
    setUrl(value);
    if (!nameEdited) setName(deriveRepoName(value));
  };

  const valid = isValidRemote(url);
  const showError = url.trim() !== '' && !valid;

  const submit = (): void => {
    if (!valid) return;
    void addRepository(url.trim(), name.trim());
    setOpen(false);
    reset();
  };

  return (
    <>
      <Button variant="primary" loading={open} onClick={() => setOpen(true)}>
        {t('repositories.add')}
      </Button>
      <Modal open={open} onClose={cancel} title={t('repositories.add')}>
        <div className="sk-repo-form">
          <TextField
            placeholder={t('repositories.addRemote')}
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
          />
          {showError && <p className="sk-repo-form__error">{t('repositories.invalidRemote')}</p>}
          <TextField
            placeholder={t('repositories.addName')}
            value={name}
            maxLength={MAX_REPO_NAME_LENGTH}
            onChange={(e) => {
              setNameEdited(true);
              setName(e.target.value);
            }}
          />
          <div className="sk-repo-form__actions">
            <Button variant="secondary" onClick={cancel}>
              {t('common.close')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={!valid}>
              {t('repositories.add')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
