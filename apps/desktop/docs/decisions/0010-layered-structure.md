# 0010: FSD-inspired layered architecture

## Status

Accepted

## Context

SkillKeeper's desktop GUI is a React renderer through which users browse, install, verify, and
repair AI-agent skills and hooks. It is deliberately a thin front end: the real work happens in
the Electron main process, which owns the filesystem, Git, configuration, and the
`@skillkeeper/core` engine, and the renderer talks to it only over the typed IPC bridge.

We needed a structure that makes that thin-client discipline visible - somewhere for the
transport layer, somewhere for shared display vocabulary, and explicit rules for which part of
the UI may depend on which. We also expected the generic UI kit to eventually be worth pulling
into a reusable package, which meant the layers had to have clean seams.

Feature-Sliced Design (FSD) offered a vocabulary and a layering model close to what we were
after, but it defines no horizontal infrastructure layer and its conventions for shared code
diverge from ours.

## Decision

Adopt an FSD-inspired layered architecture, where renderer code lives under `src/renderer/`
(each layer at `src/renderer/<layer>/`, with `@/` aliased to `src/renderer/`). Imports run
strictly downward - a higher layer may pull from a lower one, never the other way:

```
downward-only dependency order:
  app
   `--> pages
         `--> features
               `--> entities
                     `--> domain
                           `--> shared

  systems = cross-cutting, horizontal (sits alongside features, not inside the chain)
```

| Layer | Purpose |
|---|---|
| `app/` | Bootstrap, providers, router, store setup |
| `pages/` | Route-level screens that compose features and entities |
| `features/` | Self-contained user actions and flows |
| `entities/` | Product building blocks and their UI |
| `domain/` | UI-side domain vocabulary and pure formatters |
| `shared/` | Generic UI kit, hooks, utilities - no product knowledge |
| `systems/` | Cross-cutting infrastructure (modals, routing, onboarding) |

This layering applies to the renderer only; the Electron `src/main/` and `src/preload/` roots
sit outside it. Two deliberate departures from textbook FSD: the horizontal `systems/` layer
(see [0020](0020-cross-cutting-systems.md)) and the dedicated `domain/` layer (see
[0050](0050-domain-vocabulary.md)).

## Consequences

- The thin-client boundary is structural - the `services/` transport layer is the only route
  to the main process, making it hard to slip filesystem or Git logic into the UI.
- Ownership stays local: a change to one feature is contained within its folder.
- Off-the-shelf FSD lint presets need tweaking to account for the non-standard `systems/` and
  `domain/` layers.
- The generic `shared/` UI kit and the `systems/` modules are the obvious things to extract
  should we ever publish a reusable package.
