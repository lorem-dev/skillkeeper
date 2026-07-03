import { useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { deriveRepoName } from '@/entities/repository';
import { Button, Modal, TextField } from '@/shared/ui';
import './RepoAddButton.scss';

export function RepoAddButton() {
  const t = useTranslator();
  const addRepository = useSkillkeeperStore((s) => s.addRepository);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);

  const reset = (): void => {
    setUrl('');
    setName('');
    setNameEdited(false);
  };

  const cancel = (): void => {
    setOpen(false);
    reset();
  };

  const onUrlChange = (value: string): void => {
    setUrl(value);
    if (!nameEdited) setName(deriveRepoName(value));
  };

  const submit = (): void => {
    if (url.trim() === '') return;
    void addRepository(url.trim(), name.trim());
    setOpen(false);
    reset();
  };

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        {t('repositories.add')}
      </Button>
      <Modal open={open} onClose={cancel} title={t('repositories.add')}>
        <div className="sk-repo-form">
          <TextField
            placeholder={t('repositories.addRemote')}
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
          />
          <TextField
            placeholder={t('repositories.addName')}
            value={name}
            onChange={(e) => {
              setNameEdited(true);
              setName(e.target.value);
            }}
          />
          <div className="sk-repo-form__actions">
            <Button variant="secondary" onClick={cancel}>
              {t('common.close')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={url.trim() === ''}>
              {t('repositories.add')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
