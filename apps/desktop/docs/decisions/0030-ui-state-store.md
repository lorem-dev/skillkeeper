# 0030: Zustand for renderer state

## Status

Accepted

## Context

The renderer carries two kinds of state: its own UI state (which modal is open, the current
selection, layout, unsaved drafts) and snapshots of data that genuinely lives in the Electron
main process (config, repositories, skills, projects), read over the IPC bridge.

The main process is authoritative for everything it owns - the filesystem, Git, configuration,
application state, and the `@skillkeeper/core` engine. The renderer never owns that data; it
keeps a mirrored copy so the UI has something to render between IPC round-trips. We wanted a
single small, predictable store for both kinds of state - no heavyweight reducer-and-middleware
setup and no separate async-cache library, since there is no HTTP backend to cache against, only
typed `invoke` calls into the local main process.

## Decision

Use [Zustand](https://zustand.docs.pmnd.rs) as the one renderer store. A single store holds both
UI state and the mirrored main-process snapshots, along with the actions that load and update
them.

Broadly, the store carries:

- `config` and per-section config validity flags,
- `repositories`, `skills`, and `projects` (the mirrored main-process data),
- loading and error flags per area, and
- actions such as `loadAll(bridge)`, `setConfig`, and `setRepositories`.

`loadAll(bridge)` fetches the current data through the `services/` transport and writes it into
the store; feature actions update their slice of the store once an IPC call succeeds.

The rule that keeps this honest: the store is a mirror, not a second source of truth. After any
action that changes main-process state (installing a skill, adding a repository, editing config),
re-read the affected data over the bridge so the mirror matches what the main process actually
holds. Never mutate the mirror optimistically and assume it is right.

## Consequences

- The mirror-not-source rule has to be applied consistently. The hazard is drift - store data
  that no longer reflects the main process. Always reconcile by reloading after a mutating call
  rather than trusting a local edit.
- One store, one mental model: developers always know where a given piece of state lives.
- No reducer/middleware ceremony and no separate query-cache library to learn or maintain.
