import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { bridgeClient } from '@/services/bridge';
import type { EditorOption } from '@/services/bridge';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { SplitButton, Button, Tooltip, Icon, Skeleton } from '@/shared/ui';

// Persist the chosen opener (separate from the config-editor choice). 'default'
// opens the OS file manager (Finder/Explorer) -- the default for a folder.
const STORAGE_KEY = 'sk-project-opener';
const DEFAULT_ID = 'default';

// Editor detection is filesystem-only and stable for the session; cache it at
// the module level and dedupe concurrent first loads.
let editorsCache: EditorOption[] | null = null;
let editorsPromise: Promise<EditorOption[]> | null = null;

function loadEditors(): Promise<EditorOption[]> {
  if (editorsCache !== null) return Promise.resolve(editorsCache);
  editorsPromise ??= bridgeClient.listEditors().then((list) => {
    editorsCache = list;
    return list;
  });
  return editorsPromise;
}

function EditorIconImage({ src }: { readonly src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Icon name="folder" />;
  return <img src={src} width={20} height={20} alt="" onError={() => setFailed(true)} />;
}

function openerIcon(option: EditorOption | undefined): ReactNode {
  if (option === undefined || option.id === DEFAULT_ID) return <Icon name="folder" />;
  if (option.iconDataUrl !== undefined) return <EditorIconImage src={option.iconDataUrl} />;
  return <Icon name="folder" />;
}

/**
 * Primary-button icons. For the file-manager default, a single folder icon.
 * For a chosen editor, its app icon followed by a project glyph ("open <project>
 * in <app>").
 */
function primaryIcon(option: EditorOption | undefined): ReactNode {
  if (option === undefined || option.id === DEFAULT_ID) return <Icon name="folder" />;
  return (
    <>
      {openerIcon(option)}
      <Icon name="projects" size={16} />
    </>
  );
}

export interface OpenProjectButtonProps {
  /** Project folder to open. */
  readonly path: string;
  /** Called before opening (e.g. to re-check the folder still exists); return
   * false to cancel the open. */
  readonly beforeOpen?: () => Promise<boolean> | boolean;
}

/**
 * Opens a project folder in the chosen IDE, or the OS file manager (the
 * default). SplitButton listing detected editors plus the file-manager default;
 * the choice is remembered in localStorage. Failures surface as a notification.
 */
export function OpenProjectButton({ path, beforeOpen }: OpenProjectButtonProps) {
  const t = useTranslator();
  const notify = useSkillkeeperStore((s) => s.notify);
  const [editors, setEditors] = useState<EditorOption[] | null>(() => editorsCache);
  const [selected, setSelected] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ID);

  useEffect(() => {
    if (editorsCache !== null) return;
    let alive = true;
    void loadEditors().then((list) => {
      if (alive) setEditors(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  const tooltip = t('projects.open');

  function labelFor(option: EditorOption): string {
    return option.id === DEFAULT_ID ? t('projects.openInFileManager') : option.name;
  }

  async function open(id: string): Promise<void> {
    if (beforeOpen !== undefined && !(await beforeOpen())) return;
    const result = await bridgeClient.openProject(path, id);
    if (!result.ok) notify(t('projects.openFailed'), 'error');
  }

  if (editors === null) {
    return <Skeleton width={74} height={30} radius="var(--sk-radius-sm)" />;
  }

  if (editors.length === 0) {
    return (
      <Tooltip content={tooltip}>
        <Button variant="secondary" aria-label={tooltip} onClick={() => void open(DEFAULT_ID)}>
          <Icon name="folder" />
        </Button>
      </Tooltip>
    );
  }

  const selectedOption = editors.find((e) => e.id === selected);

  return (
    <SplitButton
      size="compact"
      icon={primaryIcon(selectedOption)}
      tooltip={tooltip}
      menuLabel={tooltip}
      onPrimary={() => void open(selected)}
      items={editors.map((e) => ({
        id: e.id,
        label: labelFor(e),
        icon: openerIcon(e),
        onSelect: () => {
          setSelected(e.id);
          localStorage.setItem(STORAGE_KEY, e.id);
          void open(e.id);
        },
      }))}
    />
  );
}
