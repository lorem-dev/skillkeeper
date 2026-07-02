import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { bridgeClient } from '@/services/bridge';
import type { EditorOption } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { SplitButton, Button, Tooltip, Icon } from '@/shared/ui';

const STORAGE_KEY = 'sk-config-editor';
const DEFAULT_ID = 'default';

function editorIcon(option: EditorOption | undefined): ReactNode {
  if (option?.iconDataUrl !== undefined) {
    return <img src={option.iconDataUrl} width={20} height={20} alt="" />;
  }
  return <Icon name="edit" />;
}

/**
 * Opens the config file in the user's preferred editor. Renders a
 * SplitButton listing the detected editors (persisting the last choice in
 * localStorage, not in config), or a single plain Button when no editors
 * were detected.
 */
export function OpenConfigButton() {
  const t = useTranslator();
  const [editors, setEditors] = useState<EditorOption[]>([]);
  const [selected, setSelected] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ID,
  );

  useEffect(() => {
    let alive = true;
    void bridgeClient.listEditors().then((list) => {
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

  // Fallback: no editors listed -> single edit button opening the default app.
  if (editors.length === 0) {
    return (
      <Tooltip content={tooltip}>
        <Button variant="secondary" aria-label={tooltip} onClick={() => void open(DEFAULT_ID)}>
          <Icon name="edit" />
        </Button>
      </Tooltip>
    );
  }

  const selectedOption = editors.find((e) => e.id === selected);

  return (
    <SplitButton
      icon={editorIcon(selectedOption)}
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
