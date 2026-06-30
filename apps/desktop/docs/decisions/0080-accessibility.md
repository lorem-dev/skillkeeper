# 0080: Accessibility scope for the desktop window

## Status

Accepted

## Context

SkillKeeper ships as an Electron desktop application: the renderer is a Chromium window driven
mostly with mouse and keyboard by a developer at their own machine. It is not a public web page,
and we have no sign of assistive technology in the loop for this tool today.

Full WAI-ARIA and screen-reader support would carry a real, ongoing cost here - ARIA wiring to
maintain, more test surface, and a lint gate (`eslint-plugin-jsx-a11y`) that would surface a
large backlog - all for a near-zero present audience.

At the same time, a control wired with an ARIA role that cannot actually be operated - no
keyboard handler, not focusable - is simply a bug. The role promises a contract the component
does not keep, and that is worth catching no matter the audience.

## Decision

Scope accessibility work to control *operability* rather than assistive-technology coverage:

- **In scope (kept):** interactive elements built on non-native tags must be operable. A `<div>`
  or `<span>` carrying `role="button"` / `role="checkbox"` plus an `onClick` must also be
  focusable (`tabIndex`) and respond to the matching keys (Enter / Space). Prefer a native
  `<button>` for click-only controls.
- **Out of scope (not pursued for now):** screen-reader-only affordances and broad ARIA coverage
  - `role="dialog"` / `aria-modal` on modals, `aria-label` on icon-only controls purely for
  narration, live regions. These may be added opportunistically but are not required and are not
  treated as defects.
- **No `eslint-plugin-jsx-a11y` gate.** We do not add it to the lint config; accessibility is not
  enforced in CI beyond the operability and `alt` rules already in place.

Revisit this if SkillKeeper ever targets users who depend on assistive technology.

## Consequences

- Keyboard operability of custom interactive primitives (Checkbox, Popover trigger, and so on) is
  still expected and should be tested.
- Reviewers should not flag missing screen-reader affordances as defects for this app; point to
  this decision instead.
- If the target audience shifts, this decision should be superseded by one that adopts the
  jsx-a11y gate and full ARIA coverage.
