# 0030: Zustand for renderer state

## Status

Accepted

## Context

The renderer carries two kinds of state: its own UI state (which modal is open, the current
selection, layout, unsaved drafts) and snapshots of data that genuinely lives in the Rust
backend (config, repositories, skills, projects), read over the bridge.

The Rust backend is authoritative for everything it owns - the filesystem, Git, configuration,
application state, and the `skillkeeper-core` engine. The renderer never owns that data; it
keeps a mirrored copy so the UI has something to render between bridge round-trips. We wanted a
single small, predictable store for both kinds of state - no heavyweight reducer-and-middleware
setup and no separate async-cache library, since there is no HTTP backend to cache against, only
typed Tauri `invoke` calls into the Rust backend.

## Decision

Use [Zustand](https://zustand.docs.pmnd.rs) as the one renderer store. A single store holds both
UI state and the mirrored backend snapshots, along with the actions that load and update
them.

Broadly, the store carries:

- `config` and per-section config validity flags,
- `repositories`, `skills`, and `projects` (the mirrored backend data),
- loading and error flags per area, and
- actions such as `loadAll(bridge)`, `setConfig`, and `setRepositories`.

`loadAll(bridge)` fetches the current data through the `services/` transport and writes it into
the store; feature actions update their slice of the store once a bridge call succeeds.

The rule that keeps this honest: the store is a mirror, not a second source of truth. After any
action that changes backend state (installing a skill, adding a repository, editing config),
re-read the affected data over the bridge so the mirror matches what the Rust backend actually
holds. Never mutate the mirror optimistically and assume it is right.

## Consequences

- The mirror-not-source rule has to be applied consistently. The hazard is drift - store data
  that no longer reflects the Rust backend. Always reconcile by reloading after a mutating call
  rather than trusting a local edit.
- One store, one mental model: developers always know where a given piece of state lives.
- No reducer/middleware ceremony and no separate query-cache library to learn or maintain.
