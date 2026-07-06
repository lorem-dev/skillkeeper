import { useEffect, useMemo, useState } from 'react';
import type { Repository } from '@/services/bridge';
import { bridgeClient } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { MAX_REPO_NAME_LENGTH } from '@/entities/repository';
import { Button, Combobox, Modal, TextField } from '@/shared/ui';
import type { ComboboxOption } from '@/shared/ui';
import './RepoEditModal.scss';

/** Longest branch name shown in the picker before it is ellipsized. */
const MAX_BRANCH_LABEL = 25;

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
  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (repository === null) return undefined;
    setName(repository.name);
    setUrl(repository.url);
    setBranch(repository.branch ?? '');
    setBranches([]);
    setConfirmDelete(false);
    let cancelled = false;
    void bridgeClient.listBranches(repository.id).then((list) => {
      if (!cancelled) setBranches(list);
    });
    // With no stored branch, preselect the clone's current branch.
    if (repository.branch === undefined || repository.branch === '') {
      void bridgeClient.describeRepository(repository.id).then((info) => {
        if (!cancelled && info.branch !== null) setBranch(info.branch);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [repository]);

  // Include the selected branch even if it is not in the fetched list yet.
  const branchOptions = useMemo<ComboboxOption[]>(() => {
    const names = new Set(branches);
    if (branch !== '') names.add(branch);
    return [...names].map((b) => ({ value: b, label: b }));
  }, [branches, branch]);

  const save = (): void => {
    if (repository === null) return;
    void updateRepository(repository.id, name.trim(), url.trim(), branch === '' ? undefined : branch);
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
        <TextField
          value={name}
          maxLength={MAX_REPO_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('repositories.addName')}
        />
        <TextField value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('repositories.addRemote')} />
        <Combobox
          label={t('repositories.branch')}
          options={branchOptions}
          value={branch}
          onChange={setBranch}
          placeholder={t('repositories.branchSearch')}
          emptyText={t('repositories.branchNone')}
          maxLabelLength={MAX_BRANCH_LABEL}
        />
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
