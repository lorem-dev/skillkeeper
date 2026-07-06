import { useEffect, useState } from 'react';
import type { Project } from '@/services/bridge';
import { bridgeClient } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { MAX_REPO_NAME_LENGTH } from '@/entities/repository';
import { Button, Modal, TextField, Tooltip, Icon } from '@/shared/ui';
import './ProjectEditModal.scss';

export interface ProjectEditModalProps {
  readonly project: Project | null;
  readonly onClose: () => void;
}

export function ProjectEditModal({ project, onClose }: ProjectEditModalProps) {
  const t = useTranslator();
  const updateProject = useSkillkeeperStore((s) => s.updateProject);
  const removeProject = useSkillkeeperStore((s) => s.removeProject);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (project !== null) {
      setName(project.name);
      setPath(project.path);
      setConfirmDelete(false);
    }
  }, [project]);

  async function choose(): Promise<void> {
    const picked = await bridgeClient.selectFolder();
    if (picked !== null) setPath(picked);
  }

  function save(): void {
    if (project === null) return;
    void updateProject(project.id, path.trim(), name.trim());
    onClose();
  }
  function remove(): void {
    if (project === null) return;
    void removeProject(project.id);
    onClose();
  }

  return (
    <Modal open={project !== null} onClose={onClose} title={t('projects.edit')}>
      <div className="sk-project-form">
        <TextField
          value={name}
          maxLength={MAX_REPO_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('projects.name')}
        />
        <div className="sk-project-form__folder">
          <span className="sk-project-form__path" title={path}>
            {path}
          </span>
          <Tooltip content={t('projects.changeFolder')}>
            <Button variant="secondary" aria-label={t('projects.changeFolder')} onClick={() => void choose()}>
              <Icon name="folder" />
            </Button>
          </Tooltip>
        </div>
        <div className="sk-project-form__actions">
          <Tooltip content={t('projects.removeKeepsFolder')}>
            <Button variant="destructive" onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}>
              {confirmDelete ? t('projects.removeConfirm') : t('projects.remove')}
            </Button>
          </Tooltip>
          <Button variant="primary" onClick={save} disabled={path.trim() === ''}>
            {t('repositories.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
