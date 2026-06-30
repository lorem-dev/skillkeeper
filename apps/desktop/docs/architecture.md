# Frontend Architecture

This guide covers the layer model, what each directory is responsible for, the import rules between them, and the conventions of the SkillKeeper desktop GUI - the React renderer for managing AI-agent skills and hooks, riding on top of the shared `@skillkeeper/core` engine.

If layered frontend architecture or this codebase is new to you, open the
[Glossary](glossary.md) first. It defines the terms we lean on (`domain`, `model`, `entity`,
`feature`, and the rest) in plain language, with analogies aimed at developers arriving from
the server side.

The choices behind all of this are written up in the [design decisions](decisions/readme.md).

---

## Layers

The renderer is organized as an FSD-inspired layered stack. Dependencies flow one way only: a
layer may reach down into the layers below it, and never up.

```
   [ top: most specific ]
        app             may import -> everything below
         |
        pages           may import -> everything below
         |
        features        may import -> everything below
         |
        entities        may import -> everything below
         |
        domain          may import -> everything below
         |
        shared          may import -> (nothing - the floor)
   [ bottom: most generic ]

   off to the side (horizontal, not part of the vertical stack):
   . systems   cross-cutting; sits beside features
   . services  IPC transport + shared types; reachable by domain, entities, features, app
```

These layers do **not** sit directly under `src/`. All renderer code lives under
`src/renderer/`, so every layer path is `src/renderer/<layer>/`. The `@/` import alias
resolves to `src/renderer/`, which is why imports read as `@/features/...`,
`@/entities/...`, and so on. The Electron main and preload roots, `src/main/` and
`src/preload/`, live **outside** this layering - the layered architecture described here
applies only to the renderer.

| Layer | Path | Purpose |
|---|---|---|
| `app/` | `src/renderer/app/` | Bootstrap, providers, router, store setup |
| `pages/` | `src/renderer/pages/` | Route-level components, page composition |
| `features/` | `src/renderer/features/` | Self-contained user actions and flows |
| `entities/` | `src/renderer/entities/` | Product building blocks and entity-level UI |
| `systems/` | `src/renderer/systems/` | Cross-cutting infrastructure: modals, routing, onboarding |
| `services/` | `src/renderer/services/` | The IPC bridge to the Electron main process and the shared types it carries |
| `domain/` | `src/renderer/domain/` | UI-side domain vocabulary: constants, pure formatters, display labels |
| `shared/` | `src/renderer/shared/` | Generic UI kit, utilities, hooks - no product knowledge |

The reasoning is in [decision 0010](decisions/0010-layered-structure.md),
[decision 0020](decisions/0020-cross-cutting-systems.md), and
[decision 0050](decisions/0050-domain-vocabulary.md).

---

## State Management

A single [Zustand](https://zustand.docs.pmnd.rs) store backs the renderer. It carries the
app's own UI state together with the snapshots of main-process data that the renderer pulls
across the IPC bridge:

| The store holds | Examples |
|---|---|
| **UI state** | Modal visibility, current selection, layout state, unsaved drafts |
| **Mirrored main-process data** | `config` and per-section config validity, `repositories`, `skills`, `projects`, plus loading and error flags per area |
| **Actions** | `loadAll(bridge)`, `setConfig`, `setRepositories`, and the per-feature setters that update the store after a successful IPC call |

Everything the Electron main process owns - the filesystem, Git, config, application state,
and the `@skillkeeper/core` engine - is authoritative there. The store keeps only a copy of
what the renderer reads over IPC, and that copy must stay aligned with the main process.
Whenever an action mutates main-process state, re-read the affected data over the bridge and
store the fresh result rather than relying on a local edit.

The full rationale is in [decision 0030](decisions/0030-ui-state-store.md).

---

## Directory Responsibilities

### `app/`

Application entry and global infrastructure.

- Router initialization, global layout
- Zustand store setup
- App bootstrap, root providers

Rules: no screen-specific UI, no direct `window.skillkeeper.*` calls (except shared initialization), no business logic.

---

### `systems/`

Cross-application infrastructure shared by many features.

Examples: `systems/onboarding`, `systems/modals`, `systems/routing`.

Each system may contain: `index.ts`, `lib/`, `ui/`, `model/`.

Rules:
- may be used from `app`, `features`, and `pages`
- may depend on `domain`, `shared`, and `services`
- must not depend on `pages`

---

### `entities/`

Product building blocks - the nouns the product is about, rather than the actions a user takes.

Current entities: `repository`, `agent`, `skill`, `install`, `project`, `hook`.

Every entity **must** have:
```
entities/ > skill/
  |- ui/        :: React components and styles
  |- model/     :: Store selectors and hooks, types (if any)
  |- lib/       :: Pure helpers, content labels, entity utilities
  |- assets/    :: Images (if needed)
  `- index.ts   :: Barrel - the only public entry point
```

`index.ts` must use **explicit named exports** (no `export *`). Whatever a consumer needs comes through this barrel; internal paths remain private.

Rules:
- cross-entity imports are allowed but should be rare and stable
- may depend on `domain`, `services`, and `shared`
- must not depend on `pages` or `features`

---

### `features/`

User actions and use-cases - the things the user *does*.

The set of features expands over time; check `src/renderer/features/` for what exists today
(for example `repoAdd`, `hookConsent`, `skillVerify`, `projectAdd`, `skillRepair`,
`updateCheck`, `skillsFiltering`, `skillsSorting`, `skillUpdate`, `configEdit`, `skillInstall`, `repoUpdate`,
`skillUninstall`).

Every feature **must** have:
```
features/ > skillInstall/
  |- ui/        :: Components and styles
  |- model/     :: Store actions/selectors, hooks
  |- lib/       :: Feature-local helpers (if any)
  `- index.ts   :: Barrel
```

Rules:
- compose `systems`, `domain`, `entities`, `shared`, and `services`
- may compose other features through their barrels (`@/features/x`) - reusable
  blocks such as `skillsFiltering` or the action buttons from `skillVerify` are
  themselves features; avoid import cycles, and when two features need each other,
  pull the shared part into an entity (see [decision 0060](decisions/0060-feature-composition.md))
- may contain mutations, orchestration, invalidation, and interaction logic
- must not depend on `pages`
- aim to stay reusable across multiple pages

---

### `pages/`

Route-level screens. They assemble features and entities into a complete page.

Current pages: `Settings`, `Projects`, `About`, `Skills`, `Onboarding`, `SkillDetails`, `Repositories`.

Rules:
- compose `entities`, `shared`, `features`, `systems`
- no direct bridge calls - use the service hooks
- must not be imported by another page
- minimal business logic - delegate to features or entities

---

### `services/`

The transport layer connecting the sandboxed renderer to the Electron main process.

```
services/ > bridge/
  |- invoke.ts      :: Typed wrappers over window.skillkeeper.* IPC calls, grouped per area
  |- client.ts      :: Thin client object that exposes the invoke wrappers to consumers
  |- types.ts       :: Single barrel of shared types re-exported from the workspace packages
  `- index.ts       :: The one public barrel: re-exports the client and the shared types
```

The renderer never touches the main process directly. It reaches `window.skillkeeper.*` only
through this layer, which presents a thin client over a set of typed `invoke` wrappers (one
per area: skills, repositories, config, updates). There is no query-cache layer and no query
keys - a call is just a typed promise into the local main process. The shared types it
handles come re-exported from the workspace packages:
`@skillkeeper/core` (the domain model - `Skill`, `Hook`, `Repository`, `Project`, `AgentTarget`,
`AgentKind`, `InstallManifest`, `ManagedFile`, `ManagedHookEdit`, verify reports, and so on),
`@skillkeeper/config`, and `@skillkeeper/i18n`. Those packages are the single source of truth for
the types - nothing is code-generated and there is no schema to regenerate.

Every layer pulls the shared types only through `@/services/bridge` - never straight from the
workspace packages and never from `bridge/types`. We use the `@skillkeeper/core` shapes as the
renderer's model directly, because they are already well-named and domain-oriented. A parallel
set of UI types with mapper functions would only earn its keep if a core shape drifted far from
what the UI needs - which it has not.

Rules:
- any React hooks that wrap a bridge call live near the consuming feature or entity, not inside the raw transport code
- must not depend on React in the transport primitives themselves
- must not render UI or store UI state

---

### `domain/`

UI-side domain vocabulary and pure display logic. Lives at `src/renderer/domain/`.

```
domain/
  |- resolution.ts    :: Skill-resolution scheme vocabulary
  |- format.ts        :: Version and hash formatting, managed-file display helpers
  |- agents.ts        :: Agent-kind helpers and presentation metadata
  |- status.ts        :: Status and verification label maps
  |- install.ts       :: Install-scope vocabulary and helpers (project vs global)
  `- consts.ts        :: UI constants: AgentKind labels, InstallScope (project/global), HookApplyStrategy, etc.
```

Rules:
- all files are plain TypeScript (no React)
- may depend on `shared` and `services`
- must not depend on `features`, `pages`, `systems`, or `entities`
- `domain -> services` is allowed because domain helpers format the shared core types (e.g. turning
  an `InstallManifest` into a friendly status label). This is a deliberate exception; domain code
  depends only on the stable shared types from `@/services/bridge`, not on transport details.

**Boundary between `domain/` and `entities/*/lib/`:** logic that is specific to a single
entity (skill filter groups, skill sort options, hook-apply labels, for instance) belongs in
`entities/<x>/lib/`. Cross-entity vocabulary or shared display logic (agent kinds, install
scopes, verification status labels, version/hash formatting) belongs in `domain/`.

> The actual engine - the business rules that install, verify, and repair skills - lives in
> `@skillkeeper/core` inside the **main** process. The renderer's `domain/` is neither that
> engine nor a DDD business-rule layer; it is the UI's shared vocabulary and display logic.
> There is no `window.<engine>` singleton in the renderer.

See [decision 0050](decisions/0050-domain-vocabulary.md) for the reasoning behind this layer.

---

### `shared/`

Reusable primitives with no product knowledge.

Contains: UI components (Button, Spinner, Tooltip, etc.), generic hooks, utilities, i18n helpers, focus management, animations, and design tokens.

Rules:
- product-specific components belong in `entities`, not here
- must stay generic - move code here only if it is product-agnostic
- must not depend on `pages`, `systems`, `features`, or `entities`

---

## Working with the workspace packages

The desktop app is one app inside a pnpm workspace, and it draws on several shared packages
under `packages/`:

| Package | What it provides | Where it runs |
|---|---|---|
| `@skillkeeper/core` | The domain model plus the install/verify/repair engine and the git port | Main-process runtime |
| `@skillkeeper/config` | Config loading and validation | Main-process runtime |
| `@skillkeeper/i18n` | Translations | Shared |
| `@skillkeeper/agents` | The agent adapter registry | Main-process runtime |

How the desktop consumes them depends on the process:

- **In the renderer, import only TYPES.** Pull domain shapes in as type-only imports
  (`import type { Skill } from '@skillkeeper/core'`), and reach them through the single
  `services` barrel rather than the packages directly. Never call these packages' runtime or
  Node functions from the renderer - cross the IPC bridge instead.
- **In the main process, use the runtime APIs directly.** The runtime entry points -
  `createNodeFs`, `loadConfig`, `registerBuiltinAgents`, the install/verify engine, the git
  port - are fair game in main-process code.
- **No prebuild in dev.** `@skillkeeper/*` resolves to each package's TypeScript source
  through the electron-vite alias, so there is no library build step to run while developing.

To bring in a new shared package:

1. Add it as a workspace dependency of the desktop app.
2. Re-export the types the renderer needs through the `services` barrel.
3. Add an IPC channel for any runtime capability the renderer has to invoke.

---

## Import Boundaries

### Allowed

```
app        | may import from: shared, domain, services, entities, features, systems, pages
pages      | may import from: shared, domain, services, entities, systems, features, app*
features   | may import from: shared, domain, services, entities, systems, features, app*
entities   | may import from: shared, domain, services, entities
systems    | may import from: shared, domain, services, systems, app*
domain     | may import from: shared, domain, services
services   | may import from: shared, services
shared     | may import from: shared
```

`app*`: the only thing lower layers may import from `app/` is the typed store surface -
the bound Zustand store hook and its typed selectors at `@/app/store/...`. App-level config
under `@/app/config/...` (the modal registry, the onboarding step order) composes features and
is consumed only by `app/`, so lower layers should not reach for it - each feature owns its
own constants (its onboarding overlay ids, say), and `app/config` merely orders them. Do not
import app UI, providers, or bootstrap code from lower layers. The `eslint-plugin-boundaries` rule
permits the lower-layer `-> app` edge at the element level; keeping these imports limited to
`@/app/store/*` is a convention, not yet a lint rule. See
[decision 0060](decisions/0060-feature-composition.md).

### Forbidden

```
pages    | must NOT import from: pages
features | must NOT import from: pages
entities | must NOT import from: app, systems, features, pages
shared   | must NOT import from: app, domain, services, systems, features, entities, pages
services | must NOT import from: React components
domain   | must NOT import from: app, systems, features, entities, pages
```

`eslint-plugin-boundaries` in `eslint.config.mjs` enforces the boundaries; whenever this matrix
and that config disagree, the config is authoritative.

---

## Barrel Exports

Every module (`entity`, `feature`, `system`) exposes a public API through `index.ts`. That is the only file consumers should import from.

Rules:
- internal paths (`entities/skill/ui/Skill.tsx`) are private; import only through the barrel
- inside a module, use relative imports (`./model/store`, `../lib/helpers`)
- use `export type { X }` for pure TypeScript interfaces/types
- use **explicit named exports** - no `export *` (it breaks IDE reference navigation)

The `no-restricted-imports` ESLint rule blocks deep imports: any `@/entities/X/...`,
`@/features/X/...`, or `@/systems/X/...` path that goes around the barrel is a lint error.

**Stateless reusable UI blocks** (for example `skillsFiltering` or `skillsSorting`) sit in
`features/` even when they have no `model/` segment. We do not use the FSD `widgets/` layer;
these are simply features without user-initiated state changes. The "features describe user
actions" rule applies to features that own store actions; stateless display blocks composing
entity UI are equally welcome here instead of in a separate layer.

---

## Naming Conventions

| Thing | Convention |
|---|---|
| Components | `PascalCase.tsx` |
| Hooks | `useSomething.ts` |
| Utils / helpers | `camelCase.ts` |
| Constants | `UPPER_CASE` for primitive constants, `camelCase` for config objects |
| Folders | `camelCase` (match the main export name) |
| Feature names | describe the action - `skillInstall`, `repoAdd` |
| Entity names | describe the product concept - `skill`, `repository` |
| Page names | describe the route - `Repositories`, `Settings` |

---

## Commands

This is a pnpm workspace. Turn on the bundled package manager once, then install:

```sh
corepack enable
pnpm install
```

Day-to-day, run from the repo root:

```sh
pnpm lint        # ESLint, including the boundary and alt rules
pnpm typecheck   # tsc across the workspace
pnpm test:cov    # tests with coverage (90% gate)
pnpm build       # build all packages
```

The desktop app runs under electron-vite. Start it with the workspace filter:

```sh
pnpm --filter @skillkeeper/desktop dev
```

Browse the `shared/ui` kit in isolation with Storybook (light/dark theme
toggle in the toolbar):

```sh
pnpm --filter @skillkeeper/desktop storybook         # dev server on :6006
pnpm --filter @skillkeeper/desktop build-storybook   # static build
```

Stories are co-located with their component as `Component.stories.tsx` under
`shared/ui/`. Storybook is a standalone dev tool: it is not part of the
lint/typecheck/test/build gates, and it renders the renderer without the
Electron main/preload layers.

There is no code-generation step - the renderer's shared types come straight from the
workspace packages.

---

## Internationalization (i18n)

**Every user-facing string MUST be translated.** No hardcoded display literals in
components - not in JSX text, not in `aria-label`/`title`/`placeholder`, not in
button or empty-state copy. A string a user can read is a translation key, always.

Translations live in the `@skillkeeper/i18n` package, consumed in the renderer as
types and through the bound translator hook.

How to add and use a string:

1. **Define the key in the English catalog** - `packages/i18n/src/catalogs/en.ts`
   is the single source of truth. Its object literal's keys are the canonical
   `MessageKey` union, so a mistyped key is a compile error. Conventions:
   - Keys are ASCII and dotted by area: `nav.*`, `common.*`, `<page>.*`,
     `config.*`, and so on.
   - Use `{name}` tokens for interpolation, e.g. `'common.errorPrefix': 'Error: {message}'`.
2. **Read it through the translator hook**, never by importing a catalog directly:
   ```tsx
   import { useTranslator } from '@/systems/i18n';
   const t = useTranslator();
   // ...
   <p>{t('repositories.empty')}</p>
   <div>{t('common.errorPrefix', { message })}</div>
   ```
   `useTranslator` binds to the active language from config and falls back to `en`.
3. **Provide every language.** Add the key to `de.ts` and `ru.ts` as well. Those
   catalogs are `Partial<Catalog>` - a missing key falls back to English at
   runtime, but a shipped string is expected to exist in **all** supported
   languages (`en`, `de`, `ru`). Their values MAY use non-ASCII (umlauts,
   Cyrillic) - the catalogs are the one place non-ASCII is allowed.
4. **Shared primitives take text via props.** `shared/ui` components must not
   import `@/systems/i18n` (it would break the layer boundary - `shared` cannot
   depend on `systems`). They accept display text as a prop; the calling page or
   feature passes an already-translated string (e.g. `<Spinner label={t('common.loading')} />`).
   A literal default on such a prop is a developer fallback only, never the value a
   user is expected to see.

Adding a supported language is: extend the `Lang` union and the `catalogs` map in
`packages/i18n/src/index.ts`, then ship a catalog file for it.

---

## Images and Accessibility

Every `<img>` **must** declare an `alt` attribute. This is enforced by the
`no-restricted-syntax` ESLint rule in `eslint.config.mjs`, so an `<img>` without `alt`
fails `pnpm lint`.

- **Meaningful images** (something the user needs to perceive): give a short, descriptive
  English `alt`.
- **Decorative images** (icons, spinners, ornamental art that carry no information): set
  `aria-hidden` and a short, non-empty English `alt`. `aria-hidden` keeps the element out of the
  accessibility tree (screen readers stay silent), while the `alt` text shows only if the image
  fails to load - a graceful broken-image fallback that is never otherwise announced or displayed.
  Use `alt=""` only when no fallback label makes sense (for example an animated loading spinner).

See [decision 0080](decisions/0080-accessibility.md) for how far accessibility work is scoped in this app.

---

## Anti-patterns

- Using `export *` in barrel files
- Importing one page into another page
- Putting business logic directly inside React components
- Placing product-specific (domain-aware) components in `shared/`
- Calling `window.skillkeeper.*` directly from UI components instead of going through `services/`
- Circular dependencies through barrels (a file in `entities/skill/` importing from `@/entities/skill`)
- An `<img>` without an `alt` attribute (use `alt=""` for purely decorative images)
- A user-facing string hardcoded in a component instead of an i18n catalog key (see Internationalization)
- Deep imports that bypass the entity/feature barrel (`@/entities/skill/ui/Skill`)
- Importing `@/services/bridge/types` directly - use `@/services/bridge`
- Letting the mirrored store data drift from the main process - mutating the store optimistically and not re-reading after a state-changing IPC call
- Threading bridge payloads through the UI tree without using the named types from `@/services/bridge`
