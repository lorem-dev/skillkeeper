# 0040: as const + type alias instead of TypeScript enums

## Status

Accepted

## Context

TypeScript `enum`s bring baggage that cuts against our goals:

1. **Reverse mappings.** Numeric enums emit a two-way lookup (`enum Foo { A = 0 }` yields both
   `Foo.A === 0` and `Foo[0] === 'A'`), which we rarely want and which adds weight.
2. **Runtime output.** Enums compile to an IIFE that persists in the emitted JavaScript, even
   under erasable-types / `isolatedModules` settings.
3. **Bundle noise.** String enums add extra object literals to the output.
4. **Interop friction.** Values coming from outside the type system - a string read from config,
   a value crossing the IPC bridge - cannot be assigned to an enum type without a cast.

The renderer targets zero TypeScript-only runtime artifacts in its output
(`verbatimModuleSyntax`, an erasable-types philosophy), so anything that leaves a runtime trace
is unwelcome.

## Decision

Reach for an `as const` object plus a `ValueOf` type alias wherever an enum would otherwise be
used:

```ts
// instead of:
enum InstallScope { Project = 'project', Global = 'global' }

// use:
export const InstallScope = {
  Project: 'project',
  Global: 'global',
} as const;
export type InstallScope = ValueOf<typeof InstallScope>;
```

`ValueOf<T>` is the project utility `type ValueOf<T> = T[keyof T]`.

## Consequences

- Outside values (a scope string read over the bridge) satisfy the type directly, with no cast.
- Narrowing and exhaustive `switch` checks behave just as they would with string enums.
- No runtime output for something that is logically an enum - the object tree-shakes like any
  other constant.
- A couple of extra lines at the declaration site, but call sites read exactly like enum usage.
