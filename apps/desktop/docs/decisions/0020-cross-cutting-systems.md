# 0020: systems/ layer for cross-cutting infrastructure

## Status

Accepted

## Context

Textbook FSD offers no equivalent of `systems/`. Yet infrastructure like modal management,
routing helpers, and the onboarding flow has no comfortable home in the standard stack: `app/`
is the composition root and too heavy to reuse, `shared/` is meant to carry no product
knowledge, and tying these concerns to one feature is wrong since many features rely on them.

These modules are also exactly the kind of self-contained infrastructure that might one day be
lifted into a reusable package, so we wanted them isolated behind clean public APIs.

## Decision

Add a `systems/` layer (at `src/renderer/systems/`) for cross-cutting, product-aware
infrastructure that:

- is used horizontally across many features and pages,
- depends on no specific entity or feature, and
- is built to be self-contained and potentially extractable.

Current contents:

| Module | Responsibility |
|---|---|
| `systems/modals/` | Central modal registry and lifecycle |
| `systems/routing/` | Routing helpers and guards |
| `systems/onboarding/` | First-run onboarding orchestration |

Import rules: `systems/` may depend on `shared`, `services`, and `domain`, and must not depend
on `pages`. Other layers reach a system through its barrel only, never its internals.

## Consequences

- Pulling a system out later is mostly a matter of relocating one self-contained folder.
- It demands discipline: a `systems/` module must not quietly accumulate feature-specific
  logic, or the seam stops being clean.
- Cross-cutting concerns get a clear home and stop bleeding into `shared/` or `app/`.
