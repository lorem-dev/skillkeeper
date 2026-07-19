// One-time migration: convert the compiled TS message catalogs
// (packages/i18n/dist/catalogs/*.js) into gettext `.po` files under `locales/`,
// which become the single source of truth. Run once (after `pnpm build:libs`):
//
//     node scripts/i18n-catalogs-to-po.mjs
//
// Keyed msgids: msgid = the dotted message key, msgstr = the (translated) text.
// English is the canonical key set; other languages carry only their present
// keys (missing ones fall back to English at runtime). Ongoing generation
// (.po -> .mo and .po -> TS catalogs) lives in scripts/gen-i18n.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'packages', 'i18n', 'dist', 'catalogs');
const OUT = join(ROOT, 'locales');

const LANGS = [
  'en', 'de', 'ru', 'uk', 'be', 'fr', 'ja', 'zh-cn',
  'pl', 'sr-cyrl', 'sr-latn', 'zh-tw', 'es', 'pt', 'ko', 'it',
];

function escapePo(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

async function loadCatalog(lang) {
  const mod = await import(pathToFileURL(join(DIST, `${lang}.js`)).href);
  const catalog = Object.values(mod).find((v) => v && typeof v === 'object');
  if (!catalog) throw new Error(`no catalog object exported by ${lang}.js`);
  return catalog;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const en = await loadCatalog('en');
  const keys = Object.keys(en);

  for (const lang of LANGS) {
    const catalog = await loadCatalog(lang);
    const lines = [
      'msgid ""',
      'msgstr ""',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '"Content-Transfer-Encoding: 8bit\\n"',
      `"Language: ${lang}\\n"`,
      '',
    ];
    // Emit in the English key order so diffs are stable and translators see the
    // canonical set. A key absent from a non-English catalog is skipped.
    for (const key of keys) {
      const value = catalog[key];
      if (value === undefined) continue;
      lines.push(`msgid "${escapePo(key)}"`);
      lines.push(`msgstr "${escapePo(String(value))}"`);
      lines.push('');
    }
    writeFileSync(join(OUT, `${lang}.po`), lines.join('\n'));
    console.log(`${lang}.po: ${Object.keys(catalog).length} messages`);
  }
  console.log(`\nwrote ${LANGS.length} .po files to locales/ (${keys.length} keys in en)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
