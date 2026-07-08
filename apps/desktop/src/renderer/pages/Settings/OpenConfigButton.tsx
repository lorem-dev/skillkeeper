import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { bridgeClient } from '@/services/bridge';
import type { EditorOption } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { SplitButton, Button, Tooltip, Icon, Skeleton } from '@/shared/ui';

const STORAGE_KEY = 'sk-config-editor';
const DEFAULT_ID = 'default';

// Editor detection probes the filesystem and does not change while the app runs,
// so cache it at the module level (lives for the session). Remounting the
// Settings page reuses this instead of re-probing; a shared in-flight promise
// dedupes concurrent first loads. Kept here in the component module rather than
// the global store -- it is a detail of this control, not app state.
let editorsCache: EditorOption[] | null = null;
let editorsPromise: Promise<EditorOption[]> | null = null;

function loadEditors(): Promise<EditorOption[]> {
  if (editorsCache !== null) return Promise.resolve(editorsCache);
  if (editorsPromise === null) {
    editorsPromise = bridgeClient.listEditors().then((list) => {
      editorsCache = list;
      return list;
    });
  }
  return editorsPromise;
}

/** An editor's icon <img>, falling back to a placeholder glyph if it fails to load. */
function EditorIconImage({ src }: { readonly src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Icon name="placeholder" />;
  return <img src={src} width={20} height={20} alt="" onError={() => setFailed(true)} />;
}

function editorIcon(option: EditorOption | undefined): ReactNode {
  if (option?.iconDataUrl !== undefined) {
    return <EditorIconImage src={option.iconDataUrl} />;
  }
  return <Icon name="edit" />;
}

/**
 * Primary-button icons: the chosen editor's app icon followed by an edit glyph,
 * so the control reads as "edit in <app>". When there is no app icon (the OS
 * default app), just the edit glyph.
 */
function primaryIcon(option: EditorOption | undefined): ReactNode {
  if (option?.iconDataUrl !== undefined) {
    return (
      <>
        <EditorIconImage src={option.iconDataUrl} />
        <Icon name="edit" size={16} />
      </>
    );
  }
  return <Icon name="edit" />;
}

/**
 * Opens the config file in the user's preferred editor. Renders a
 * SplitButton listing the detected editors (persisting the last choice in
 * localStorage, not in config), or a single plain Button when no editors
 * were detected. While the (session-cached) editor list loads, a skeleton the
 * size of the control holds the space so the layout does not jump.
 */
export function OpenConfigButton() {
  const t = useTranslator();
  const [editors, setEditors] = useState<EditorOption[] | null>(() => editorsCache);
  const [selected, setSelected] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ID,
  );

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

  const tooltip = t('settings.openConfigInEditor');

  function labelFor(option: EditorOption): string {
    return option.id === DEFAULT_ID ? t('settings.editor.defaultApp') : option.name;
  }

  async function open(id: string): Promise<void> {
    const result = await bridgeClient.openConfigInEditor(id);
    if (!result.ok) {
      // Minimal surfacing; a richer toast is a follow-up.
      console.error(t('settings.openConfigFailed'), result.error);
    }
  }

  // Loading: hold the control's footprint with a skeleton so nothing reflows.
  if (editors === null) {
    return <Skeleton width={74} height={30} radius="var(--sk-radius-sm)" />;
  }

  // Fallback: no editors listed -> single edit button opening the default app.
  if (editors.length === 0) {
    return (
      <Tooltip content={tooltip}>
        <Button variant="secondary" glass aria-label={tooltip} onClick={() => void open(DEFAULT_ID)}>
          <Icon name="edit" />
        </Button>
      </Tooltip>
    );
  }

  const selectedOption = editors.find((e) => e.id === selected);

  return (
    <SplitButton
      size="compact"
      glass
      icon={primaryIcon(selectedOption)}
      tooltip={tooltip}
      menuLabel={tooltip}
      onPrimary={() => void open(selected)}
      items={editors.map((e) => ({
        id: e.id,
        label: labelFor(e),
        icon: editorIcon(e),
        onSelect: () => {
          setSelected(e.id);
          localStorage.setItem(STORAGE_KEY, e.id);
          void open(e.id);
        },
      }))}
    />
  );
}
