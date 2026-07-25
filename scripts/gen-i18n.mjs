// Generate localization artifacts from the single source of truth: the gettext
// `.po` files under `locales/`. Run whenever a `.po` changes:
//
//     pnpm run i18n                  (all languages -- the default)
//     pnpm run i18n -- ru de         (only these)
//     pnpm run i18n -- --langs=ru,de (same, comma-separated)
//
// Regenerating a subset is a convenience for iterating on one translation; the
// committed sources are the `.po` files either way. `en` is always regenerated,
// since `catalogs/en.ts` defines the `MessageKey`/`Catalog` types every other
// catalog imports.
//
// Produces:
//   packages/i18n/src/catalogs/<lang>.ts   TS catalogs for the renderer
//                                           (en is the canonical key set; the
//                                            rest are Partial<Catalog>)
//   apps/desktop/src-tauri/locales/<lang>.mo   compiled catalogs the Rust menu
//                                              and CLI read via the `gettext` crate
//
// Keyed msgids: msgid = dotted message key, msgstr = (translated) text. A key
// absent from a non-English `.po` is omitted (runtime falls back to English).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import gettextParser from 'gettext-parser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, 'locales');
const TS_OUT = join(ROOT, 'packages', 'i18n', 'src', 'catalogs');
const MO_OUT = join(ROOT, 'apps', 'desktop', 'src-tauri', 'locales');

// Every supported language, in canonical order. Keep in sync with
// packages/i18n/src/langs.ts (SUPPORTED_LANGS).
const ALL_LANGS = [
  'en', 'de', 'ru', 'uk', 'be', 'fr', 'ja', 'zh-cn',
  'pl', 'sr-cyrl', 'sr-latn', 'zh-tw', 'es', 'pt', 'ko', 'it',
  'hi', 'th',
];

// Resolve which languages to generate from argv: no arguments means all.
// Accepts positional codes (`ru de`) and/or `--langs=ru,de`.
function selectLangs(argv) {
  const requested = [];
  for (const arg of argv) {
    const list = arg.startsWith('--langs=') ? arg.slice('--langs='.length) : arg;
    for (const code of list.split(',')) {
      const trimmed = code.trim();
      if (trimmed !== '') requested.push(trimmed);
    }
  }
  if (requested.length === 0) return ALL_LANGS;

  const unknown = requested.filter((l) => !ALL_LANGS.includes(l));
  if (unknown.length > 0) {
    console.error(`unknown language(s): ${unknown.join(', ')}`);
    console.error(`supported: ${ALL_LANGS.join(', ')}`);
    process.exit(1);
  }
  // Always include `en`: `catalogs/en.ts` defines the MessageKey/Catalog types
  // every other catalog imports, so regenerating a subset against a stale
  // English catalog emits a catalog whose keys are not in the type - surfacing
  // later as an opaque tsc error in generated code. Preserve canonical order and
  // drop duplicates.
  return ALL_LANGS.filter((l) => l === 'en' || requested.includes(l));
}

// 'zh-cn' -> 'zhCn' (the export name lazy.ts expects).
const camel = (lang) => lang.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
// A TS single-quoted string literal body.
const tsStr = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Read a .po into an ordered [key, value][] (skips the header entry "").
function readPo(lang) {
  const parsed = gettextParser.po.parse(readFileSync(join(LOCALES, `${lang}.po`), 'utf8'));
  const ctx = parsed.translations[''] ?? {};
  const out = [];
  for (const [msgid, entry] of Object.entries(ctx)) {
    if (msgid === '') continue;
    const value = entry.msgstr?.[0] ?? '';
    out.push([msgid, value]);
  }
  return out;
}

function writeEnCatalog(entries) {
  const body = entries.map(([k, v]) => `  ${tsStr(k)}: ${tsStr(v)},`).join('\n');
  return `/**
 * English catalog -- AUTO-GENERATED from locales/en.po by scripts/gen-i18n.mjs.
 * Do not edit by hand; edit the .po and run \`pnpm run i18n\`.
 * The canonical key set: MessageKey is derived from these keys.
 */
export const en = {
${body}
} as const;

/** The union of all valid translation keys. */
export type MessageKey = keyof typeof en;

/** A widened catalog shape where every value is \`string\`. */
export type Catalog = { [K in MessageKey]: string };
`;
}

function writeLangCatalog(lang, entries) {
  const name = camel(lang);
  const body = entries.map(([k, v]) => `  ${tsStr(k)}: ${tsStr(v)},`).join('\n');
  return `/**
 * ${lang} catalog -- AUTO-GENERATED from locales/${lang}.po by scripts/gen-i18n.mjs.
 * Do not edit by hand; edit the .po and run \`pnpm run i18n\`.
 */
import type { Catalog } from './en.js';

export const ${name}: Partial<Catalog> = {
${body}
};
`;
}

function main() {
  const langs = selectLangs(process.argv.slice(2));
  mkdirSync(TS_OUT, { recursive: true });
  mkdirSync(MO_OUT, { recursive: true });

  for (const lang of langs) {
    const entries = readPo(lang);
    // TS catalog (renderer).
    const ts = lang === 'en' ? writeEnCatalog(entries) : writeLangCatalog(lang, entries);
    writeFileSync(join(TS_OUT, `${lang}.ts`), ts);
    // Compiled .mo (Rust menu + CLI). Re-serialize from the parsed .po.
    const parsed = gettextParser.po.parse(readFileSync(join(LOCALES, `${lang}.po`), 'utf8'));
    writeFileSync(join(MO_OUT, `${lang}.mo`), gettextParser.mo.compile(parsed));
    console.log(`${lang}: ${entries.length} messages -> catalogs/${lang}.ts + locales/${lang}.mo`);
  }
  const scope = langs.length === ALL_LANGS.length ? '' : ` (${langs.join(', ')})`;
  console.log(
    `\ngenerated ${langs.length} TS catalogs + ${langs.length} .mo files from locales/${scope}`,
  );
}

main();
