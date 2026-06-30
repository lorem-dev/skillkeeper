# Design Decisions

This is the decision log for the SkillKeeper desktop renderer. Each entry captures a notable
architectural or technical choice: what prompted it, the call we made, and what followed.
The aim is that anyone joining later can reconstruct the reasoning, not just see the outcome.

These are plain design decisions - kept short and frozen once accepted. Read the log as
append-only history rather than living documentation: if a choice is later reversed, add a new
entry that supersedes the old one instead of editing the original.

## Index

| # | Title | Status |
|---|---|---|
| [0010](0010-layered-structure.md) | FSD-inspired layered architecture | Accepted |
| [0020](0020-cross-cutting-systems.md) | `systems/` layer for cross-cutting infrastructure | Accepted |
| [0030](0030-ui-state-store.md) | Zustand for renderer state | Accepted |
| [0040](0040-const-maps-over-enums.md) | `as const` + type alias instead of TypeScript enums | Accepted |
| [0050](0050-domain-vocabulary.md) | Dedicated `domain/` layer for UI-side domain vocabulary | Accepted |
| [0060](0060-feature-composition.md) | Cross-feature composition is allowed | Accepted |
| [0070](0070-bundle-analysis.md) | Sonda for bundle analysis | Accepted |
| [0080](0080-accessibility.md) | Accessibility scope for the desktop window | Accepted |

## Adding a new decision

1. Take the last number and add ten (entries are spaced by tens to leave room).
2. Name the file `NNNN-short-kebab-title.md`.
3. Use the section order `Status` / `Context` / `Decision` / `Consequences`.
4. Statuses: `Proposed` -> `Accepted` / `Rejected` / `Deprecated` / `Superseded by [NNNN]`.
5. Stay brief. Capture the context and the trade-off; you do not need to list every option weighed.
