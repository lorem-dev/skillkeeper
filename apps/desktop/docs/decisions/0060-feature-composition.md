# 0060: Cross-feature composition is allowed

## Status

Accepted

## Context

Strict FSD forbids `feature -> feature` imports and introduces a `widgets/` layer for blocks
that compose features. We deliberately drop the `widgets/` layer (see
[0010](0010-layered-structure.md)): reusable display blocks like `skillsFiltering` live in
`features/`, and a screen-level flow frequently needs to render them alongside action features
such as `skillInstall`, `skillVerify`, or `skillRepair`.

The boundaries config allows `features -> features`: composing one feature from another through
its barrel is exactly how a screen reuses a block like `skillsFiltering`. A second pull is
`features -> app`: the typed store helpers live in `app/store` and are imported from features,
pages, and systems throughout the renderer.

## Decision

- Allow `features -> features`. A feature composes another through its barrel (`@/features/x`),
  just as a page does. Avoid import cycles; when two features genuinely depend on each other,
  lift the shared part into an entity or a smaller feature rather than wiring them together.
- Allow `features` / `pages` / `systems` to import from `app/` only for the typed store helpers
  (`@/app/store/...`) and app-level config that has no better home yet. App UI, providers, and
  bootstrap code remain off-limits to lower layers.

## Consequences

- No `widgets/` layer is needed.
- The import matrix in `architecture.md` matches what `eslint-plugin-boundaries` enforces; the
  lint config stays the source of truth.
- Moving the typed store helpers out of `app/` (into a dedicated store module) would remove the
  second exception. Worth revisiting if lower-layer imports from `app` ever extend beyond store
  typing and config.
