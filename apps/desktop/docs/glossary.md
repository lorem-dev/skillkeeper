# Frontend Glossary

A plain-language dictionary for the vocabulary of the SkillKeeper desktop renderer: what a
"layer" is, what `domain`, `model`, `entity`, and `feature` mean here, why the folders are
named the way they are, and how the pieces connect.

SkillKeeper's desktop GUI is the front end for managing AI-agent skills and hooks. It is a
thin React renderer over `@skillkeeper/core`: sandboxed, it reaches the Electron main process
only through the typed IPC bridge on `window.skillkeeper`. The main process owns the
filesystem, Git, config, application state, and the core engine.

This page targets readers **new to this codebase or to layered frontend architecture**. Where
it helps, a term comes with a loose **server-side analogy** - a way to build intuition, not a
precise equivalence. One clarification: SkillKeeper has no HTTP backend of its own. Where an
analogy says "server," read it as the abstract notion of an authoritative store living
elsewhere; here that authority is the Electron main process, reached over IPC.

For the binding rules (import matrix, lint enforcement, directory responsibilities) see
[`architecture.md`](architecture.md). For the reasoning behind individual choices see the
[design decisions](decisions/readme.md). If this page and `architecture.md` ever conflict,
`architecture.md` is authoritative.

---

## The 30-second mental model

The code is sliced into **layers**. A layer is a horizontal band with a single
responsibility. The bands stack, and **imports only ever point downward**:

```
imports point DOWN this stack (a band may use anything beneath it):

  (1) app       <- top band
  (2) pages
  (3) features
  (4) entities
  (5) domain
  (6) shared    <- bottom band

  beside the stack (horizontal bands, not in the 1..6 line):
    systems   .... cross-cutting
    services  .... IPC transport / shared types
```

A lower layer never imports from a higher one. `shared` knows nothing about skills or hooks;
`app` knows about everything. It is the same idea as Clean / Hexagonal architecture: stable,
generic things at the bottom, volatile, specific things at the top, with dependencies running
downward only.

Within a layer, code groups into **modules** (one `entity`, one `feature`, one `system`), and
each module divides into **segments** (`ui`, `model`, `lib`, ...). Each module has one front
door: its `index.ts` **barrel**.

That is the entire system. The rest of this page defines each word.

---

## Layers (the horizontal bands)

These are the top-level folders under `src/renderer/`. Each row reads "what we call it" ->
"what it means here".

| Term | Folder | What it means in this repo | Server-side analogy |
|---|---|---|---|
| **app** | `src/renderer/app/` | Bootstrap and global wiring: root providers, Zustand store setup, router, top-level layout. The composition root. | `main()` / the DI container that wires everything together |
| **page** | `src/renderer/pages/` | One route-level screen. Composes features and entities into a full screen; almost no logic of its own. | A route handler that assembles a response from services |
| **feature** | `src/renderer/features/` | Something the user *does* - a self-contained action or flow (`skillInstall`, `repoAdd`, `hookConsent`). Verbs. | A use-case / application service that runs one task |
| **entity** | `src/renderer/entities/` | Something the product *talks about* - a building block and its UI (`skill`, `hook`, `repository`). Nouns. | A model object plus the code that renders and reads it |
| **system** | `src/renderer/systems/` | Cross-cutting infrastructure used across many features (`modals`, `routing`, `onboarding`). Drawn off to the side because it is horizontal, not part of the downward stack. | Framework-level middleware / platform services |
| **service** | `src/renderer/services/` | The transport layer: the typed client over `window.skillkeeper` and the shared types it carries. The only path to the main process. | A client SDK / gateway plus the types crossing its boundary |
| **domain** | `src/renderer/domain/` | UI-side domain vocabulary and pure formatters over the core types: agent kinds, install scopes, status labels, version/hash formatting. Plain TypeScript, no React. | See the **important note** below - it is *not* the classic DDD domain layer |
| **shared** | `src/renderer/shared/` | Generic, product-agnostic primitives: the UI kit (`Button`, `Tooltip`), hooks, utils, design tokens, i18n helpers. Reusable on any project. | A `common` / internal stdlib package |

Note that these are renderer-only folders. The Electron `src/main/` and `src/preload/` roots
sit outside this layering, and the `@/` alias maps to `src/renderer/`.

### `domain` vs `entities` - the one that trips people up

Both sound like "the domain layer" a server-side dev expects. They are split on purpose:

- **`entities/<x>/lib/`** holds logic **specific to one entity**: skill filter groups, skill
  sort options, hook-apply labels.
- **`domain/`** holds **cross-entity, UI-side** vocabulary and formatting: install scopes
  (project / global), agent-kind labels, version and hash formatting, hook apply strategies,
  status and verification labels, skill-resolution schemes. It does not know about React and
  does not belong to any single entity.

Rule of thumb from `architecture.md`: *if it is specific to one entity, it goes in that
entity's `lib/`; if it is cross-entity vocabulary or shared display logic, it goes in
`domain/`.*

> **Important for server-side readers:** our `domain/` is **not** a DDD aggregate /
> business-rule layer. The real business rules - the engine that installs, verifies, and
> repairs skills - live in `@skillkeeper/core` in the Electron main process. On the
> renderer, `domain/` is the shared *vocabulary and display logic* for the UI: think "the
> labels and formatters for the things on screen," not "the place where invariants are
> enforced." There is no engine singleton in the renderer. See
> [decision 0050](decisions/0050-domain-vocabulary.md).

### `entities` vs `features` vs `pages`

A quick litmus test:

- Can you name it as a **noun** the product owns? -> **entity** (`skill`, `repository`).
- Can you name it as a **thing the user does**? -> **feature** (`skillInstall`,
  `skillsFiltering`).
- Is it a **whole screen at a route**? -> **page** (`Skills`, `Settings`).

Stateless reusable display blocks (for example `skillsFiltering`) also live in `features/`
even though they hold no state - we do not use a separate `widgets/` layer. See the Barrel
Exports note in [`architecture.md`](architecture.md).

---

## Module anatomy: modules and segments

Inside `entities/`, `features/`, and `systems/`, each subfolder is one **module** (one
entity, one feature, one system). A module is split into **segments** - the `ui/`,
`model/`, `lib/` folders. Segments are a *technical role*; the module is a *product concept*.

| Term | Folder | What goes here | Server-side analogy |
|---|---|---|---|
| **module** | `features/skillInstall/`, `entities/skill/` | One self-contained product concept. The unit you import. | A bounded package/module |
| **segment** | `ui/`, `model/`, `lib/`, ... | A slice of a module by technical role | Sub-packages by responsibility |
| **ui** | `<module>/ui/` | React components and their styles (`.tsx` + `.module.scss`) | The view / presentation layer |
| **model** | `<module>/model/` | State and behavior: store actions and selectors, hooks, local constants | The stateful service layer for that feature |
| **lib** | `<module>/lib/` | Pure helpers, label maps, formatting - no state, no JSX | Pure utility functions |
| **assets** | `<module>/assets/` | Images and static files used by that module | Bundled static resources |
| **invoke** | `services/bridge/invoke.ts` | The typed `window.skillkeeper.*` wrappers, grouped per area (skills, repositories, config) | The client methods that call the boundary |
| **index.ts** | every module | The **barrel** - the only file other code may import from | A package's exported surface |

Only `ui/` and `index.ts` are mandatory. `model/` exists only if the module has state;
`lib/` and `assets/` only if needed (for example `entities/skill` might have `ui/` + `lib/`
but no `model/`).

---

## State and data terms

The renderer keeps one [Zustand](https://zustand.docs.pmnd.rs) store
([decision 0030](decisions/0030-ui-state-store.md)). It holds both the UI's own state and the
snapshots of main-process data the renderer reads over the bridge.

| Term | What it means | Server-side analogy |
|---|---|---|
| **store** | The single Zustand object. Holds UI state plus the mirrored `config`, `repositories`, `skills`, and `projects`, with loading/error flags and the actions that load and update them. Set up in `app/store/`. | An in-memory state container |
| **mirrored data** | A renderer-held copy of data the main process owns. The store mirrors what it reads over IPC; the main process stays the source of truth. | A local cache of authoritative records |
| **action** | A store function that changes state - for example `loadAll(bridge)`, `setConfig`, `setRepositories`. | A state mutator |
| **selector** | A function that reads a value out of the store (often derived/memoized). | A read query / getter over state |
| **bridge** | `window.skillkeeper`, the typed `contextBridge` IPC surface the sandboxed renderer uses to reach the main process. Wrapped by `services/`. | The client SDK to an authoritative store |
| **invoke wrapper** | A typed function in `services/bridge/invoke.ts` that calls one `window.skillkeeper.*` method and returns a typed promise. | A typed client method |

> The store is a **mirror, not a second source of truth.** After any action that changes
> main-process state, re-read the affected data over the bridge and write the result back.
> Letting the mirror drift from the main process is an anti-pattern. See
> [`architecture.md`](architecture.md).

---

## SkillKeeper domain terms

Specific to this product. The shapes come from `@skillkeeper/core`; the UI-side vocabulary
and formatting live in `domain/`.

| Term | What it means |
|---|---|
| **skill** | An installable unit of agent capability (typically a `SKILL.md` plus supporting files). The central entity. |
| **hook** | A privileged edit SkillKeeper applies to an agent's configuration. Installing one goes through the `hookConsent` permission flow. |
| **repository** | A source of skills the user has added, kept in sync over Git. |
| **project** | A target location (a folder/workspace) where skills are installed. |
| **agent** | An AI coding agent SkillKeeper installs into. An `AgentTarget` names a concrete one; `AgentKind` is its type. |
| **install scope** | Where a skill is installed - per `project` or `global`. Vocabulary lives in `domain/install.ts`. |
| **install manifest** | The `InstallManifest` from `@skillkeeper/core` recording what was installed and where (its `ManagedFile`s and `ManagedHookEdit`s). |
| **verify / repair** | Checking an installed skill against its manifest (`skillVerify`) and restoring it when it has drifted (`skillRepair`). Verify reports come from the core types. |

These names are the model the renderer works with - imported through the one
`@/services/bridge` barrel.

---

## General architecture terms

| Term | What it means |
|---|---|
| **FSD (Feature-Sliced Design)** | The community methodology our structure is *inspired by*. It is where the names `features`, `entities`, `shared`, and the `ui`/`model`/`lib` segments come from. We adapt it - see [decision 0010](decisions/0010-layered-structure.md). |
| **layer** | A horizontal band with one responsibility and a fixed position in the import order. |
| **import boundary** | The rule for which layer may import which. Enforced by `eslint-plugin-boundaries`; the matrix lives in `architecture.md` and `eslint.config.mjs`. |
| **import direction** | Imports point downward only (`features` may use `entities`, never the reverse). Keeps the dependency graph acyclic. |
| **barrel** | A module's `index.ts` that re-exports its public API. The single legal entry point into the module. |
| **public API** | What a module exposes through its barrel. Everything else in the module is private. |
| **deep import** | Reaching past the barrel into a module's internals (`@/entities/skill/ui/Skill`). A lint error - always import the barrel (`@/entities/skill`). |
| **named export** | We export by name (`export { Skill }`), never `export *`, so IDE "find references" works. Types use `export type`. |
| **cross-cutting** | A concern that does not belong to one layer because it spans many (modals, routing). Lives in `systems/`. |
| **composition root** | The single place (`app/`) where concrete modules are wired together. |

---

## "Why is the folder called that?" - the short answers

- **`services`** rather than `bridge` alone: it is the whole transport story - the typed
  client, the invoke wrappers, and the shared types - not just the raw IPC call.
- **`shared`** rather than `common` or `utils`: it carries the extra promise that the code
  here has **zero product knowledge** and could be lifted into any project.
- **camelCase folders, PascalCase components**: the folder name matches its main export;
  React components are PascalCase by convention. See Naming Conventions in
  [`architecture.md`](architecture.md).
- **`features` and `entities`** rather than `components` and `models`: the split is by
  *purpose*, not *file type*. A feature keeps its UI **and** its state **and** its helpers in
  one place, so everything about "installing a skill" lives together rather than scattered
  across `components/`, `store/`, `utils/`. The names come from FSD.
- **`ui` / `model` / `lib`** segments: a consistent internal vocabulary so every module is
  cut the same way. Open any feature and you know exactly where the components, the state,
  and the helpers are.
- **`systems`** rather than putting modals/routing in `shared` or `features`: they are
  horizontal infrastructure, so they get their own off-to-the-side layer
  ([decision 0020](decisions/0020-cross-cutting-systems.md)).
- **`domain`** rather than `core`: it is the shared *vocabulary* of the UI. (See the note
  above - it is not the DDD domain layer, and not the `@skillkeeper/core` engine.)

---

## Where does my code go? (quick decision guide)

1. Is it a **whole screen at a route**? -> `pages/`
2. Is it **something the user does** (an action/flow)? -> `features/<thing>`
3. Is it a **product noun** and its display/reads? -> `entities/<thing>`
4. Is it **cross-cutting infra** used everywhere (modal, route helper)? -> `systems/<thing>`
5. Does it **talk to the main process** (an IPC call, a shared type)? -> `services/bridge`
6. Is it **cross-entity vocabulary or shared display logic**? -> `domain/`
7. Is it **generic with no product knowledge** (a button, a date util)? -> `shared/`
8. Within a module: a **component** -> `ui/`, **state/hooks** -> `model/`, **a pure helper**
   -> `lib/`.

When two answers fit, prefer the **lower** layer that still makes sense (more reusable), and
make sure imports still point downward.

---

## See also

- [`architecture.md`](architecture.md) - the binding rules, import matrix, anti-patterns
- [Design decisions](decisions/readme.md) - the reasoning behind each choice
- Root `AGENTS.md` - repo-wide conventions (commits, typography, testing)
