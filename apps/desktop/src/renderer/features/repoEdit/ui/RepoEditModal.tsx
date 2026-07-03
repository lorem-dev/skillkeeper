import { useEffect, useState } from 'react';
import type { Repository } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button, Modal, TextField } from '@/shared/ui';
import './RepoEditModal.scss';

export interface RepoEditModalProps {
  readonly repository: Repository | null;
  readonly onClose: () => void;
}

export function RepoEditModal({ repository, onClose }: RepoEditModalProps) {
  const t = useTranslator();
  const updateRepository = useSkillkeeperStore((s) => s.updateRepository);
  const removeRepository = useSkillkeeperStore((s) => s.removeRepository);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (repository !== null) {
      setName(repository.name);
      setUrl(repository.url);
      setConfirmDelete(false);
    }
  }, [repository]);

  const save = (): void => {
    if (repository === null) return;
    void updateRepository(repository.id, name.trim(), url.trim());
    onClose();
  };
  const remove = (): void => {
    if (repository === null) return;
    void removeRepository(repository.id);
    onClose();
  };

  return (
    <Modal open={repository !== null} onClose={onClose} title={t('repositories.edit')}>
      <div className="sk-repo-form">
        <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder={t('repositories.addName')} />
        <TextField value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('repositories.addRemote')} />
        <div className="sk-repo-form__actions">
          <Button variant="destructive" onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}>
            {confirmDelete ? t('repositories.deleteConfirm') : t('repositories.delete')}
          </Button>
          <Button variant="primary" onClick={save} disabled={url.trim() === ''}>
            {t('repositories.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
