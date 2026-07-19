# Localization (i18n)

SkillKeeper ships in 16 languages. Every user-facing string flows from a
**single source of truth** -- the gettext `.po` catalogs under `locales/` -- into
both the desktop renderer (TypeScript) and the native macOS menu (Rust). This
page describes that pipeline and how to add or change translations.

## Source of truth

`locales/<lang>.po` are the only files you edit by hand. They are keyed gettext
catalogs: the `msgid` is a **dotted message key** (e.g. `nav.repositories`,
`menu.edit`) and the `msgstr` is the text for that language.

- `locales/en.po` is canonical: it defines the full key set. The TypeScript
  `MessageKey` type is derived from it, so a key must exist in `en.po` to be
  usable.
- A key omitted from a non-English `.po` falls back to the English value at
  runtime (per key), in every consumer.

Supported codes (canonical order): `en, de, ru, uk, be, fr, ja, zh-cn, pl,
sr-cyrl, sr-latn, zh-tw, es, pt, ko, it`.

## The generation pipeline

`scripts/gen-i18n.mjs` (run with `pnpm run i18n`) compiles the `.po` sources
into the artifacts each consumer needs:

```
locales/<lang>.po                                 (SOURCE -- hand-edited)
        |
        |  pnpm run i18n   (scripts/gen-i18n.mjs, uses gettext-parser)
        v
packages/i18n/src/catalogs/<lang>.ts              renderer catalogs (TypeScript)
apps/desktop/src-tauri/locales/<lang>.mo          compiled catalogs (Rust menu)
```

- `catalogs/en.ts` exports the canonical `en` object plus the `MessageKey` and
  `Catalog` types; the other `catalogs/<lang>.ts` export a `Partial<Catalog>`.
- `<lang>.mo` are compiled gettext binaries the Rust side reads.

Both sets of generated files are **git-ignored, not committed**. The renderer
imports the `.ts` at build time and the Rust menu embeds the `.mo` via
`include_bytes!` at `cargo build` time, so they must exist -- but they are
produced automatically: `pnpm install` runs a `postinstall` hook, and
`src-tauri/build.rs` regenerates the `.mo` when missing. After editing a `.po`,
run `pnpm run i18n` (or just `pnpm install`); commit only the `.po` -- never the
regenerated `catalogs/*.ts` or `locales/*.mo`.

> **Do not edit** `packages/i18n/src/catalogs/*.ts` or
> `apps/desktop/src-tauri/locales/*.mo` by hand -- they are overwritten by
> `pnpm run i18n`. Edit the `.po` and regenerate.

## Consumers

### Desktop renderer (TypeScript)

The `@skillkeeper/i18n` package exposes the catalogs and a translator. The
renderer uses the **lazy** entry point `@skillkeeper/i18n/lazy`, which imports
only English statically and code-splits every other catalog into its own chunk
(`import()`), loaded on demand.

- `systems/i18n/runtime.ts` holds the registry of loaded catalogs, loads others
  via `ensureCatalog(lang)`, and notifies subscribers when one arrives. Startup
  and the settings language switch gate the UI on `ensureCatalog` so the English
  fallback is never flashed.
- `useTranslator()` (`systems/i18n/useTranslator.ts`) returns a translator bound
  to `config.general.language`, re-rendering (via `useSyncExternalStore`) once
  the real catalog finishes loading.

The translator:

```ts
const t = useTranslator();
t('nav.repositories');                     // -> "Repositories"
t('errors.cloneFailed', { name: 'acme' }); // {name} interpolation
t.plural('skills.count', n);               // Intl.PluralRules; picks
                                           // skills.count.<one|other|...>, {count} auto-filled
```

Lookup order is primary language -> English fallback -> the raw key string.

### Native macOS menu (Rust)

`app::i18n::Translator::for_lang(<code>)` parses the embedded `.mo` (via the
pure-Rust `gettext` crate) and translates keys with the same English fallback:

```rust
let tr = app::i18n::Translator::for_lang("de");
tr.t("menu.edit"); // German, or English if the key is missing
```

The menu (`app::menu`) is built **once at startup**, reading the configured
language from `config.yaml`. Two important consequences on macOS:

- **A language change takes effect for the menu on the next launch**, not
  immediately. The renderer relocalizes live, but the native menu is not rebuilt
  when the config changes.
- The menu items AppKit injects itself (the Window tiling group: Fill, Center,
  Move & Resize, ...) are localized by AppKit, not by us. `app::menu`'s
  `set_process_language` sets `AppleLanguages` at startup, and
  `Info.plist`'s `CFBundleLocalizations` declares the supported locales, so
  AppKit renders those items in the app's language. This too resolves at launch.

### CLI (Rust)

The `skillkeeper` CLI is **English-only by design** (`crates/skillkeeper-cli/
src/messages.rs`). It is a scripting/automation surface whose output is parsed
by tooling, so a single stable language is preferred over locale-dependent
strings. The few strings it needs are inlined as ASCII English mirroring the
`en` catalog values.

## ASCII rule

All source and documentation are ASCII-only. The **only** place non-ASCII text
is allowed is the i18n data: `locales/*.po` and `packages/i18n/` (the non-English
`catalogs/*.ts` and the native language-name table `src/nativeNames.ts`). Never
inline non-ASCII UI text in app/renderer/Rust source -- add a key instead.

## How to

### Add or change a user-facing string

1. Add/edit the key in `locales/en.po` (the canonical value).
2. Run `pnpm run i18n`.
3. Use the key via `t('your.key')` (renderer) or `tr.t("your.key")` (Rust menu).
4. Commit the `.po` change only; the regenerated `catalogs/*.ts` and
   `locales/*.mo` are git-ignored (produced on install/build).

New strings are added to `en.po` only. Do **not** translate them into other
locales as part of feature work -- untranslated keys show English until a
dedicated translation pass (before a release, or when explicitly asked).

### Translate a language

1. Fill in the `msgstr`s in `locales/<lang>.po`, preserving every `{token}`
   placeholder and providing the CLDR plural categories that locale uses
   (`<baseKey>.one`, `<baseKey>.other`, etc.).
2. Run `pnpm run i18n` and commit the `.po` (the regenerated artifacts are
   git-ignored).

### Add a new selectable language

Adding code `xx` (BCP-47 form `Xx` where it differs, e.g. `zh-cn` -> `zh-Hans`):

1. `locales/xx.po` -- create (copy `en.po`, translate).
2. `scripts/gen-i18n.mjs` -- add `xx` to `LANGS`.
3. `packages/i18n/src/langs.ts` -- add to the `Lang` union and `SUPPORTED_LANGS`.
4. `packages/i18n/src/index.ts` -- import the catalog and add it to `catalogs`.
5. `packages/i18n/src/lazy.ts` -- add a dynamic-`import()` loader.
6. `packages/i18n/src/nativeNames.ts` -- add the language's own name (and a
   Chinese qualifier if it is a Chinese script).
7. `crates/skillkeeper-config/src/schema.rs` -- add it to the `Language` enum.
8. `apps/desktop/src-tauri/src/app/i18n.rs` -- add it to `catalog_bytes`.
9. `apps/desktop/src/renderer/domain/languages.ts` -- add it to `LANGS`.
10. `apps/desktop/src-tauri/Info.plist` -- add the BCP-47 code to
    `CFBundleLocalizations` (and map it in `app::menu`'s `macos_language_code`
    if the code differs from the app code, like `zh-cn` -> `zh-Hans`).
11. Run `pnpm run i18n`; commit the `.po` and source changes (generated
    `.ts`/`.mo` are git-ignored).

## Native language names

The language picker uses `LANGUAGE_NATIVE_NAMES` from
`packages/i18n/src/nativeNames.ts` (each locale's own name for itself), not
`Intl.DisplayNames` -- the system WebView's ICU data is unreliable for some
locales.

## Dependencies / licenses

- `gettext` (Rust crate, MIT) -- reads the compiled `.mo` for the menu.
- `gettext-parser` (npm, MIT) -- parses `.po` and compiles `.mo` in
  `scripts/gen-i18n.mjs`.
