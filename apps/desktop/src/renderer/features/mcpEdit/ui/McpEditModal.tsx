/**
 * Manual MCP preset editor: create or edit one entry of `config.mcp.servers`.
 * See the design spec "MCP support" section 7 ("Manual-preset editor modal").
 */
import { useEffect, useMemo, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import type { McpOauth, McpTransport } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import type { Translator } from '@/systems/i18n';
import { Button, Icon, Modal, TextField, Select } from '@/shared/ui';
import type { SelectOption } from '@/shared/ui';
import { oauthFromDraft, validatePreset } from '../lib/validate';
import type { KeyValueRow, McpOauthDraft, McpPresetDraft, McpTransportDraft } from '../lib/validate';
import './McpEditModal.scss';

/**
 * One manually-defined MCP server preset, as stored in `config.mcp.servers`
 * (mirrors `packages/config/src/schema.ts`'s `mcpPresetSchema` -- defined
 * locally, with mutable `args`/`headers`/`env`, rather than reusing core's
 * `McpServerDef` (whose fields are `readonly`), so a built preset assigns
 * straight into `updateConfig({ mcp: { servers } })` without a cast).
 */
export interface ManualMcpPreset {
  readonly id: string;
  readonly name: string;
  readonly type: McpTransport;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly rules?: string;
  /** A short summary, shown wherever this preset is listed. May contain one
   *  markup form, a link. The manual-preset editor authors this field and
   *  nothing else from the parameters design -- no `parameters`, no
   *  `options` editor; see the design spec's stated non-goal. */
  readonly description?: string;
  readonly oauth?: McpOauth;
}

export interface McpEditModalProps {
  readonly open: boolean;
  /** Omit to create a new preset; pass an existing one to edit it in place. */
  readonly preset?: ManualMcpPreset;
  /**
   * Requests deleting the preset being edited; the Delete button only renders
   * when both this and `preset` are set (nothing to delete when creating).
   * The caller owns confirmation (e.g. the page's shared delete-confirm
   * modal) -- this modal closes immediately once the request is made, it
   * never deletes anything itself.
   */
  readonly onDelete?: (preset: ManualMcpPreset) => void;
  readonly onClose: () => void;
}

/** Transport labels come from `mcp.protocol.*` -- kept identical across
 *  locales (like `nav.mcp`), but still routed through `t()`. */
function transportOptions(t: Translator): SelectOption[] {
  return [
    { value: 'stdio', label: t('mcp.protocol.stdio') },
    { value: 'http', label: t('mcp.protocol.http') },
    { value: 'sse', label: t('mcp.protocol.sse') },
  ];
}

const EMPTY_OAUTH_DRAFT: McpOauthDraft = { callbackPort: '', clientId: '', scopes: [] };

const EMPTY_DRAFT: McpPresetDraft = {
  name: '',
  type: 'stdio',
  url: '',
  headers: [],
  command: '',
  args: [],
  env: [],
  rules: '',
  description: '',
  oauth: EMPTY_OAUTH_DRAFT,
};

/**
 * Converts a saved `McpOauth` (or its absence) back into editable text-field
 * state.
 *
 * Every field is guarded, `scopes` included, even though the generated
 * `McpOauth` types it as a required `Array<string>`. That type is wrong on the
 * wire: Rust models `scopes` as a plain `Vec` with
 * `skip_serializing_if = "Vec::is_empty"`, so an oauth block with no scopes
 * arrives with the key ABSENT and ts-rs has no way to see that. Dropping the
 * guard would make this the one place a stored preset can crash the editor
 * open, on the most ordinary oauth block there is (a client id and nothing
 * else).
 */
function oauthDraftFromOauth(oauth: McpOauth | undefined): McpOauthDraft {
  if (oauth === undefined) return EMPTY_OAUTH_DRAFT;
  return {
    callbackPort: oauth.callbackPort !== undefined ? String(oauth.callbackPort) : '',
    clientId: oauth.clientId ?? '',
    scopes: oauth.scopes !== undefined ? [...oauth.scopes] : [],
  };
}

function recordToRows(record: Readonly<Record<string, string>> | undefined): KeyValueRow[] {
  return record === undefined ? [] : Object.entries(record).map(([key, value]) => ({ key, value }));
}

/** Drops rows with an empty key; returns `undefined` (not `{}`) when nothing is left. */
function rowsToRecord(rows: readonly KeyValueRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key !== '') out[key] = row.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function draftFromPreset(preset: ManualMcpPreset | undefined): McpPresetDraft {
  if (preset === undefined) return EMPTY_DRAFT;
  return {
    name: preset.name,
    type: preset.type,
    url: preset.url ?? '',
    headers: recordToRows(preset.headers),
    command: preset.command ?? '',
    args: preset.args !== undefined ? [...preset.args] : [],
    env: recordToRows(preset.env),
    rules: preset.rules ?? '',
    description: preset.description ?? '',
    oauth: oauthDraftFromOauth(preset.oauth),
  };
}

interface KeyValueEditorProps {
  readonly rows: readonly KeyValueRow[];
  readonly onChange: (rows: KeyValueRow[]) => void;
  readonly keyPlaceholder: string;
  readonly valuePlaceholder: string;
  readonly addLabel: string;
  readonly removeLabel: string;
  readonly invalidIndex?: number;
}

function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  removeLabel,
  invalidIndex,
}: KeyValueEditorProps) {
  const update = (index: number, patch: Partial<KeyValueRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const remove = (index: number): void => {
    onChange(rows.filter((_, i) => i !== index));
  };
  return (
    <div className="sk-mcp-edit__kv-list">
      {rows.map((row, i) => (
        <div className="sk-mcp-edit__kv-row" key={i}>
          <TextField
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <TextField
            value={row.value}
            placeholder={valuePlaceholder}
            invalid={invalidIndex === i}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Button variant="plain" aria-label={removeLabel} onClick={() => remove(i)}>
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        <Icon name="plus" />
        {addLabel}
      </Button>
    </div>
  );
}

interface ArgsEditorProps {
  readonly args: readonly string[];
  readonly onChange: (args: string[]) => void;
  readonly argumentPlaceholder: string;
  readonly addArgumentLabel: string;
  readonly removeLabel: string;
  readonly invalidIndex?: number;
}

function ArgsEditor({
  args,
  onChange,
  argumentPlaceholder,
  addArgumentLabel,
  removeLabel,
  invalidIndex,
}: ArgsEditorProps) {
  const update = (index: number, value: string): void => {
    onChange(args.map((a, i) => (i === index ? value : a)));
  };
  const remove = (index: number): void => {
    onChange(args.filter((_, i) => i !== index));
  };
  return (
    <div className="sk-mcp-edit__kv-list">
      {args.map((arg, i) => (
        <div className="sk-mcp-edit__arg-row" key={i}>
          <TextField
            value={arg}
            placeholder={argumentPlaceholder}
            invalid={invalidIndex === i}
            onChange={(e) => update(i, e.target.value)}
          />
          <Button variant="plain" aria-label={removeLabel} onClick={() => remove(i)}>
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...args, ''])}>
        <Icon name="plus" />
        {addArgumentLabel}
      </Button>
    </div>
  );
}

export function McpEditModal({ open, preset, onDelete, onClose }: McpEditModalProps) {
  const config = useSkillkeeperStore((s) => s.config);
  const updateConfig = useSkillkeeperStore((s) => s.updateConfig);
  const t = useTranslator();
  const [draft, setDraft] = useState<McpPresetDraft>(EMPTY_DRAFT);

  useEffect(() => {
    if (open) setDraft(draftFromPreset(preset));
  }, [open, preset]);

  // Only the FIRST error is surfaced, on purpose: `validatePreset` orders its
  // findings the way a user fills the form in, and marking every field at once
  // turns one mistake into a wall of red. Save stays disabled while ANY error
  // stands, so the next one appears as soon as this one is fixed -- but that
  // only works if the message is actually shown, which is why every field with
  // a possible error renders `errorFor`/`rowErrorFor` text and not just an
  // `invalid` border.
  const errors = useMemo(() => validatePreset(draft), [draft]);
  const firstError = errors[0];
  const errorFor = (field: string): string | undefined =>
    firstError?.field === field ? t(firstError.messageKey, firstError.vars) : undefined;
  const rowIndexFor = (prefix: string): number | undefined => {
    if (firstError === undefined) return undefined;
    const match = /^(\w+)\.(\d+)(\.value)?$/.exec(firstError.field);
    if (match === null || match[1] !== prefix) return undefined;
    return Number(match[2]);
  };
  /** Message text for an indexed row error (`scopes.2`, `headers.0.value`),
   *  which `errorFor` cannot match because the index is not known up front. */
  const rowErrorFor = (prefix: string): string | undefined =>
    firstError !== undefined && rowIndexFor(prefix) !== undefined
      ? t(firstError.messageKey, firstError.vars)
      : undefined;

  const setType = (value: string): void => setDraft((d) => ({ ...d, type: value as McpTransportDraft }));

  function handleSave(): void {
    if (errors.length > 0) return;
    const id = preset?.id ?? crypto.randomUUID();
    const type = draft.type as McpTransport;
    const built: ManualMcpPreset = {
      id,
      name: draft.name.trim(),
      type,
      url: type === 'http' || type === 'sse' ? draft.url.trim() : undefined,
      headers: type === 'http' || type === 'sse' ? rowsToRecord(draft.headers) : undefined,
      command: type === 'stdio' ? draft.command.trim() : undefined,
      args: type === 'stdio' && draft.args.some((a) => a !== '') ? draft.args.filter((a) => a !== '') : undefined,
      env: type === 'stdio' ? rowsToRecord(draft.env) : undefined,
      rules: draft.rules.trim() === '' ? undefined : draft.rules,
      description: draft.description.trim() === '' ? undefined : draft.description.trim(),
      oauth: type === 'http' || type === 'sse' ? oauthFromDraft(draft.oauth) : undefined,
    };
    const servers = config?.mcp.servers ?? [];
    const next = preset !== undefined ? servers.map((s) => (s.id === id ? built : s)) : [...servers, built];
    void updateConfig({ mcp: { servers: next } });
    onClose();
  }

  const isHttpLike = draft.type === 'http' || draft.type === 'sse';
  const isStdio = draft.type === 'stdio';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={preset !== undefined ? t('mcp.editTitle') : t('mcp.addTitle')}
      className="sk-mcp-edit"
    >
      <div className="sk-mcp-edit__form">
        <p className="sk-mcp-edit__help">{t('mcp.paramsHelp')}</p>

        <label className="sk-mcp-edit__field">
          <span className="sk-mcp-edit__label">{t('mcp.field.name')}</span>
          <TextField
            value={draft.name}
            invalid={errorFor('name') !== undefined}
            placeholder={t('mcp.namePlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          {errorFor('name') !== undefined && <span className="sk-mcp-edit__error">{errorFor('name')}</span>}
        </label>

        <label className="sk-mcp-edit__field">
          <span className="sk-mcp-edit__label">{t('mcp.field.description')}</span>
          <TextField
            value={draft.description}
            placeholder={t('mcp.descriptionPlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </label>

        <label className="sk-mcp-edit__field sk-mcp-edit__field--bounded">
          <span className="sk-mcp-edit__label">{t('mcp.field.type')}</span>
          <Select options={transportOptions(t)} value={draft.type} onChange={setType} ariaLabel={t('mcp.field.type')} />
          {/* The oauth-on-stdio error belongs here rather than in the OAuth
              section: switching an http preset with an auth block to stdio
              hides that whole section, so an error rendered inside it would
              leave Save disabled with nothing on screen explaining why. The
              transport select is the control the user has to change. */}
          {errorFor('oauth') !== undefined && <span className="sk-mcp-edit__error">{errorFor('oauth')}</span>}
        </label>

        {isHttpLike && (
          <>
            <label className="sk-mcp-edit__field">
              <span className="sk-mcp-edit__label">{t('mcp.field.url')}</span>
              <TextField
                value={draft.url}
                invalid={errorFor('url') !== undefined}
                placeholder={t('mcp.urlPlaceholder')}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              />
              {errorFor('url') !== undefined && <span className="sk-mcp-edit__error">{errorFor('url')}</span>}
            </label>
            <div className="sk-mcp-edit__field">
              <span className="sk-mcp-edit__label">{t('mcp.field.headers')}</span>
              <KeyValueEditor
                rows={draft.headers}
                onChange={(headers) => setDraft((d) => ({ ...d, headers }))}
                keyPlaceholder={t('mcp.headerNamePlaceholder')}
                valuePlaceholder={t('mcp.headerValuePlaceholder')}
                addLabel={t('mcp.addHeader')}
                removeLabel={t('mcp.remove')}
                invalidIndex={rowIndexFor('headers')}
              />
            </div>
            <div className="sk-mcp-edit__field">
              <span className="sk-mcp-edit__label">{t('mcp.field.oauth')}</span>
              <p className="sk-mcp-edit__help">{t('mcp.oauthHelp')}</p>
              <TextField
                value={draft.oauth.clientId}
                invalid={errorFor('oauth.clientId') !== undefined}
                placeholder={t('mcp.field.clientId')}
                onChange={(e) => setDraft((d) => ({ ...d, oauth: { ...d.oauth, clientId: e.target.value } }))}
              />
              {errorFor('oauth.clientId') !== undefined && (
                <span className="sk-mcp-edit__error">{errorFor('oauth.clientId')}</span>
              )}
              <TextField
                value={draft.oauth.callbackPort}
                invalid={errorFor('oauth.callbackPort') !== undefined}
                placeholder={t('mcp.field.callbackPort')}
                onChange={(e) => setDraft((d) => ({ ...d, oauth: { ...d.oauth, callbackPort: e.target.value } }))}
              />
              {errorFor('oauth.callbackPort') !== undefined && (
                <span className="sk-mcp-edit__error">{errorFor('oauth.callbackPort')}</span>
              )}
              <span className="sk-mcp-edit__label">{t('mcp.field.scopes')}</span>
              <ArgsEditor
                args={draft.oauth.scopes}
                onChange={(scopes) => setDraft((d) => ({ ...d, oauth: { ...d.oauth, scopes } }))}
                argumentPlaceholder={t('mcp.scopePlaceholder')}
                addArgumentLabel={t('mcp.addScope')}
                removeLabel={t('mcp.remove')}
                invalidIndex={rowIndexFor('scopes')}
              />
              {rowErrorFor('scopes') !== undefined && (
                <span className="sk-mcp-edit__error">{rowErrorFor('scopes')}</span>
              )}
            </div>
          </>
        )}

        {isStdio && (
          <>
            <label className="sk-mcp-edit__field">
              <span className="sk-mcp-edit__label">{t('mcp.field.command')}</span>
              <TextField
                value={draft.command}
                invalid={errorFor('command') !== undefined}
                placeholder={t('mcp.commandPlaceholder')}
                onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
              />
              {errorFor('command') !== undefined && <span className="sk-mcp-edit__error">{errorFor('command')}</span>}
            </label>
            <div className="sk-mcp-edit__field">
              <span className="sk-mcp-edit__label">{t('mcp.field.arguments')}</span>
              <ArgsEditor
                args={draft.args}
                onChange={(args) => setDraft((d) => ({ ...d, args }))}
                argumentPlaceholder={t('mcp.argumentPlaceholder')}
                addArgumentLabel={t('mcp.addArgument')}
                removeLabel={t('mcp.remove')}
                invalidIndex={rowIndexFor('args')}
              />
            </div>
            <div className="sk-mcp-edit__field">
              <span className="sk-mcp-edit__label">{t('mcp.field.env')}</span>
              <KeyValueEditor
                rows={draft.env}
                onChange={(env) => setDraft((d) => ({ ...d, env }))}
                keyPlaceholder={t('mcp.varNamePlaceholder')}
                valuePlaceholder={t('mcp.varValuePlaceholder')}
                addLabel={t('mcp.addVariable')}
                removeLabel={t('mcp.remove')}
                invalidIndex={rowIndexFor('env')}
              />
            </div>
          </>
        )}

        <label className="sk-mcp-edit__field">
          <span className="sk-mcp-edit__label">{t('mcp.field.rules')}</span>
          <textarea
            className={`sk-mcp-edit__textarea${errorFor('rules') !== undefined ? ' sk-mcp-edit__textarea--invalid' : ''}`}
            value={draft.rules}
            placeholder={t('mcp.rulesPlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, rules: e.target.value }))}
          />
          {errorFor('rules') !== undefined && <span className="sk-mcp-edit__error">{errorFor('rules')}</span>}
        </label>

        <div className="sk-mcp-edit__actions">
          {preset !== undefined && onDelete !== undefined && (
            <Button
              variant="destructive"
              className="sk-mcp-edit__delete"
              onClick={() => {
                onDelete(preset);
                onClose();
              }}
            >
              {t('mcp.delete')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('mcp.cancel')}
          </Button>
          <Button variant="primary" disabled={errors.length > 0} onClick={handleSave}>
            {t('mcp.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
