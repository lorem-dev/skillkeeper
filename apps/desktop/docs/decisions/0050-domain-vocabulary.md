# 0050: Dedicated domain/ layer for UI-side domain vocabulary

## Status

Accepted

## Context

The original layer stack (`app -> pages -> features -> entities -> shared`) had nowhere to put
display logic that is:

- shared by several entities and features rather than owned by any one,
- expressed in terms of the shared core types (`AgentKind`, `InstallManifest`, verify reports) -
  formatting and labelling them for the UI, and
- pure TypeScript, with no React and no UI.

In practice that code kept drifting into `shared/`, which is meant to stay free of product
knowledge. Helpers that map agent kinds to labels, name install scopes, or convert a verify
report into a status string are plainly product-aware, so parking them in `shared/` broke its
contract.

Two options were on the table:

1. Push every piece down into the entity it relates to (`entities/<x>/lib/`).
2. Add a first-class `domain/` layer at `src/renderer/domain/`, sitting below `entities` and
   above `shared`.

## Decision

Do both, choosing per module by how broad the logic is:

- **Specific to one entity** -> `entities/<x>/lib/`. For instance, skill filter groups and skill
  sort options live in `entities/skill/lib/`; hook-apply labels live in `entities/hook/lib/`.
- **Cross-entity vocabulary or shared display logic** -> `src/renderer/domain/`. This covers
  agent kinds and their presentation metadata, install scopes (project vs global), hook apply
  strategies, skill-resolution schemes, status and verification labels, and version/hash
  formatting.

`domain/` sits between `entities` and `shared`. It may import from `shared` and `services`;
nothing above it may push code down into it. The `domain -> services` edge is intentional:
domain helpers format the shared core types, so they depend on the stable types re-exported from
`@/services/bridge` - but on those types alone, never on transport details.

For anyone expecting a DDD domain layer: this is not that. The real engine - the business rules
that install, verify, and repair skills - lives in the `skillkeeper-core` Rust crate in the Rust
backend. The renderer's `domain/` is the UI's shared vocabulary and display logic, and there is
no engine singleton in the renderer.

## Consequences

- `entities/<x>/lib/` grows only with logic that truly belongs to one entity.
- `shared/` is genuinely generic again, free of product-specific code.
- A `domain -> services` boundary rule was added to the lint config, since domain files read and
  format the shared core types (for example turning an `InstallManifest` into a status label).
- Cross-entity vocabulary and formatters have a clear, permanent home.
