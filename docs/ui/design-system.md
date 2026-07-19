# SkillKeeper Desktop Design System

Status: draft (v0.1)
Scope: visual language and UI tokens for the SkillKeeper desktop app
(`apps/desktop`, Tauri + React renderer).

This document defines a self-contained design system for the desktop app. It was
derived from a reference UI kit (translucent, depth-based interface style) but is
its own system: token names, scales, and component rules belong to SkillKeeper and
are tuned for a pointer-driven desktop window, not for touch. Values for color,
radii, and material blur were measured from the reference export; spacing and
elevation scales are derived; typography is built on the bundled Inter family.

All tokens are expressed as CSS custom properties under the `--sk-` namespace so a
single source of truth can drive both light and dark themes.

---

## 1. Overview

### 1.1 Goals

- One coherent visual language across all desktop views (Projects, Repositories,
  Skills, Settings).
- A token layer (`--sk-*`) that maps cleanly to CSS, so components reference
  semantic tokens (`--sk-color-label`, `--sk-radius-lg`) and never hardcode values.
- First-class light and dark themes from the same token set.
- A depth model based on translucent "glass" surfaces layered over content.

### 1.2 Non-goals

- Pixel-faithful reproduction of any third-party kit. We take the style direction
  (translucency, soft depth, rounded geometry, a vivid accent palette) and rebuild
  it as our own system.
- Touch-first patterns. Anything that only makes sense on a phone or tablet is out
  of scope (see Section 8).

### 1.3 How to read this doc

- Section 2-7 are foundations and the token reference: implement these first.
- Section 8 covers components and desktop adaptation rules.
- Section 2-6 are the human-readable spec and rationale for each token group.

**Single source of truth.** The tokens are implemented once, in
[`apps/desktop/src/renderer/styles/_tokens.scss`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/styles/_tokens.scss).
That file is canonical: the build emits the `--sk-*` CSS custom properties from it,
and if any value in the tables below ever disagrees with the SCSS, the SCSS wins.
The tables exist to explain intent, not to be a second copy of the values - update
`_tokens.scss` and reflect the change here, never the other way around.

---

## 2. Color

The palette has three layers:

1. Accent hues - vivid colors for interactive and status accents.
2. Neutrals - a gray ramp for surfaces, separators, and fills.
3. Semantic roles - label, fill, background, and separator tokens that components
   actually consume. Components should reference semantic roles, not raw hues.

Each value below is given for light and dark themes. Hex values are measured from
the reference export.

### 2.1 Accent hues

| Token            | Light     | Dark      |
| ---------------- | --------- | --------- |
| `--sk-blue`      | `#0088FF` | `#0091FF` |
| `--sk-indigo`    | `#6155F5` | `#6D7CFF` |
| `--sk-teal`      | `#00C8B3` | `#00DAC3` |
| `--sk-cyan`      | `#00C3D0` | `#3CD3FE` |
| `--sk-green`     | `#34C759` | `#30D158` |
| `--sk-yellow`    | `#FFCC00` | `#FFD600` |
| `--sk-orange`    | `#FF9230` | `#FF8D28` |
| `--sk-red`       | `#FF383C` | `#FF4245` |
| `--sk-pink`      | `#FF2D55` | `#FF375F` |
| `--sk-purple`    | `#CB30E0` | `#DB34F2` |
| `--sk-brown`     | `#AC7F5E` | `#B78A66` |

`--sk-blue` is the primary accent (selection, primary buttons, focus). The rest are
used for status and categorical color (e.g. success = green, destructive = red,
warning = orange/yellow).

### 2.2 Neutral ramp

Light theme ramp (light to dark):

| Token          | Value     |
| -------------- | --------- |
| `--sk-gray-1`  | `#F2F2F7` |
| `--sk-gray-2`  | `#E5E5EA` |
| `--sk-gray-3`  | `#D1D1D6` |
| `--sk-gray-4`  | `#C7C7CC` |
| `--sk-gray-5`  | `#AEAEB2` |
| `--sk-gray-6`  | `#8E8E93` |

Dark theme ramp (dark to light):

| Token          | Value     |
| -------------- | --------- |
| `--sk-gray-1`  | `#1C1C1E` |
| `--sk-gray-2`  | `#2C2C2E` |
| `--sk-gray-3`  | `#3A3A3C` |
| `--sk-gray-4`  | `#48484A` |
| `--sk-gray-5`  | `#636366` |
| `--sk-gray-6`  | `#8E8E93` |

`--sk-gray-6` (`#8E8E93`) is the shared mid-gray and reads acceptably in both
themes.

### 2.3 Semantic roles

Labels are defined as a base ink color plus opacity, so the same base adapts to
secondary/tertiary/quaternary emphasis. Light base ink is near-black; dark base ink
is `#EBEBF5`; the secondary/tertiary base is `#3C3C43` (light) / `#EBEBF5` (dark).

| Role                       | Light                         | Dark                          |
| -------------------------- | ----------------------------- | ----------------------------- |
| `--sk-color-label`         | `#000000`                     | `#FFFFFF`                     |
| `--sk-color-label-2`       | `#8A8A8E`                     | `#98989E`                     |
| `--sk-color-label-3`       | `#B8B8BD`                     | `#5C5C61`                     |
| `--sk-color-label-4`       | `#CECED2`                     | `#3E3E43`                     |
| `--sk-color-fill-1`        | `#D4D4DA`                     | `#48484C`                     |
| `--sk-color-fill-2`        | `#E0E0E5`                     | `#3D3D41`                     |
| `--sk-color-fill-3`        | `#EAEAEE`                     | `#333337`                     |
| `--sk-color-separator`     | `#C9C9CD`                     | `#3A3A3D`                     |
| `--sk-color-bg`            | `#FFFFFF`                     | `#000000`                     |
| `--sk-color-bg-secondary`  | `#F2F2F7`                     | `#1C1C1E`                     |
| `--sk-color-bg-tertiary`   | `#FFFFFF`                     | `#2C2C2E`                     |
| `--sk-color-accent`        | `var(--sk-blue)`              | `var(--sk-blue)`              |

These semantic colors are **solid** (opaque), not translucent. The UI uses solid
surfaces by default so elements do not show the background through them;
transparency is reserved for things that must be see-through -- glass surfaces
(`--sk-glass-tint`, `--sk-glass-border`) and the modal scrim. Fill tokens
(`--sk-color-fill-*`) are the gray control fills (segmented track, search field,
secondary button, etc.); separators and secondary label inks are likewise solid.

---

## 3. Typography

The system typeface is **Inter** (variable, axes `opsz` 14-32 and `wght` 100-900),
bundled at `apps/desktop/src/renderer/assets/fonts/Inter-Variable.ttf` and
`Inter-Italic-Variable.ttf`. **Cormorant Garamond** (variable serif) is bundled as
an optional display face for large hero/marketing headings only; the functional UI
uses Inter exclusively.

Both faces are licensed under the SIL Open Font License (see the `*-OFL.txt` files
next to the fonts).

### 3.1 Font setup

The `@font-face` declarations live in
[`_fonts.scss`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/styles/_fonts.scss) and the
`--sk-font-*` variables in
[`_tokens.scss`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/styles/_tokens.scss); those files
are the canonical setup. Key points:

- Fonts ship as WOFF2 only (every target system WebView supports WOFF2). The variable TTFs in
  `apps/desktop/src/renderer/assets/fonts/` are the source of truth and kept for
  tooling, but the bundler ships only the smaller WOFF2 files.
- `body` sets `font-family: var(--sk-font-sans)` and `font-optical-sizing: auto`,
  which drives Inter's `opsz` axis from the font size.

### 3.2 Type scale

Desktop is denser than touch, so the base body size is 14px. Sizes are in px;
line-height is unitless. Tracking (`letter-spacing`) tightens slightly as size
grows, matching Inter's design intent.

| Role          | Token              | Size | Line-height | Weight | Tracking |
| ------------- | ------------------ | ---- | ----------- | ------ | -------- |
| Display       | `--sk-text-display`| 34   | 1.1         | 700    | -0.02em  |
| Title 1       | `--sk-text-title-1`| 26   | 1.2         | 700    | -0.02em  |
| Title 2       | `--sk-text-title-2`| 20   | 1.25        | 600    | -0.01em  |
| Title 3       | `--sk-text-title-3`| 17   | 1.3         | 600    | -0.01em  |
| Headline      | `--sk-text-headline`| 14  | 1.3         | 600    | 0        |
| Body          | `--sk-text-body`   | 14   | 1.45        | 400    | 0        |
| Callout       | `--sk-text-callout`| 13   | 1.4         | 400    | 0        |
| Subheadline   | `--sk-text-subhead`| 12   | 1.35        | 400    | 0        |
| Footnote      | `--sk-text-footnote`| 11  | 1.35        | 400    | 0.01em   |
| Caption       | `--sk-text-caption`| 10   | 1.3         | 500    | 0.02em   |

Weights map to Inter cuts: 400 Regular, 500 Medium, 600 SemiBold, 700 Bold. Use 500
for emphasis within body text and 600 for control labels and headings.

Display role optionally uses `--sk-font-display` (Cormorant Garamond) when a
softer, editorial heading is wanted; default is Inter.

---

## 4. Materials (glass surfaces)

The depth model is built on translucent "glass" surfaces: a blurred, slightly
tinted layer placed over content. Surfaces are the chrome (toolbars, sidebars,
popovers, sheets, menus); content scrolls underneath and shows through.

Measured blur radii from the reference: 5, 7.5, 15, 24. These map to four material
weights.

| Material token        | Blur (px) | Use                                   |
| --------------------- | --------- | ------------------------------------- |
| `--sk-glass-thin`     | 5         | inline chips, light overlays          |
| `--sk-glass-regular`  | 15        | toolbars, sidebars, popovers, menus   |
| `--sk-glass-thick`    | 24        | modal sheets, alerts                  |
| `--sk-glass-clear`    | 7.5       | minimal-tint overlays over media      |

Each material is a blur plus a saturation boost plus a low-opacity tint that adapts
per theme:

```css
.sk-glass-regular {
  backdrop-filter: blur(15px) saturate(180%);
  -webkit-backdrop-filter: blur(15px) saturate(180%);
  background: var(--sk-glass-tint);          /* light: rgba(255,255,255,.72)
                                                dark:  rgba(30,30,32,.72) */
  border: 0.5px solid var(--sk-color-separator);
}
```

Tint opacity guidance: thin ~0.55, regular ~0.72, thick ~0.85, clear ~0.30. Lower
opacity = more of the content below shows through. Always pair a glass surface with
a hairline border (`0.5px`) using `--sk-color-separator` to define its edge.

Fallback: if `backdrop-filter` is unavailable, fall back to the equivalent opaque
surface (`--sk-color-bg-secondary` light / `--sk-color-bg-tertiary` dark) so text
contrast is preserved.

### 4.1 Refractive glass

Beyond the flat blur, surfaces can refract the backdrop like real glass: a
per-element SVG displacement map (X/Y displacement in the R/G channels, kept
neutral in the center so it concentrates at the rim -- which reads as a rounded
glass edge) drives `feDisplacementMap`, with an optional gentle chromatic
aberration. It is applied through `backdrop-filter: url(...)`, built and
re-measured on resize by the `useGlassRefraction` hook
([`shared/lib/glassRefraction.ts`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/lib/glassRefraction.ts)).

The glass surfaces (`GlassSurface`, the Card `glass` variant, the Button `glass`
variant, and the Modal panel) clip the effect to their rounded shape
(`overflow: hidden`) so the rim refraction stays inside a clean edge, and draw a
thin gradient rim border (the `glass` SCSS mixin + `--sk-glass-border` token):
bright at the top-left and bottom-right corners and transparent at the other two,
so the rim catches light on one diagonal and blends into the backdrop elsewhere.
Two soft radial highlights layer over that diagonal to lift the rim at the top
and bottom centers as well, for a more even, lit-from-around edge (kept subtle so
the diagonal shine still dominates).
Displacement and aberration are kept low so the effect is a subtle refraction, not
a noisy distortion. It **degrades safely**: where `backdrop-filter: url()` is
unsupported it falls back to plain blur+saturate, and the surface keeps its tint +
shine so it stays readable.

Note: the refraction is only visible over backdrops with detail or contrast (text,
icons, busy imagery, patterns) -- over a flat color it is subtle by nature, where
the blur, tint, and rim shine carry the glass look instead.

The displacement-filter technique is adapted from MIT-licensed open-source work
(see the source comment in `glassRefraction.ts`).

---

## 5. Radii, spacing, elevation

### 5.1 Corner radii

Measured radii cluster into six steps (plus a pill). Inner elements use small radii;
containers use large ones. Concentric rounding rule: a child's radius should equal
the parent's radius minus the gap between them.

| Token            | Value | Use                                          |
| ---------------- | ----- | -------------------------------------------- |
| `--sk-radius-xs` | 4px   | inner fills, small chips, swatches           |
| `--sk-radius-sm` | 10px  | small controls, inline fields                |
| `--sk-radius-md` | 14px  | list rows, cells, medium cards               |
| `--sk-radius-lg` | 16px  | standard controls, segmented control track   |
| `--sk-radius-xl` | 22px  | buttons, large controls, popovers            |
| `--sk-radius-2xl`| 26px  | sheets, alerts, large containers             |
| `--sk-radius-pill`| 9999px | toggles, pills, fully rounded controls      |

### 5.2 Spacing

Spacing is a 4px-based scale (derived; absolute padding is not recoverable from the
export, so this is a deliberate system choice tuned for desktop density).

| Token          | Value |
| -------------- | ----- |
| `--sk-space-1` | 2px   |
| `--sk-space-2` | 4px   |
| `--sk-space-3` | 8px   |
| `--sk-space-4` | 12px  |
| `--sk-space-5` | 16px  |
| `--sk-space-6` | 20px  |
| `--sk-space-7` | 24px  |
| `--sk-space-8` | 32px  |

Defaults: control inner padding `--sk-space-3`/`--sk-space-4`; row padding
`--sk-space-4` vertical, `--sk-space-5` horizontal; section gaps `--sk-space-7`.

### 5.3 Elevation

Shadows are theme-varying. The light theme carries depth mostly through the drop
shadow; the values below are the light theme. The dark theme softens them
further (shadows read faintly on dark surfaces) and leans on the hairline glass
border for edge definition instead.

| Token            | Light                                  | Dark                          | Use               |
| ---------------- | -------------------------------------- | ----------------------------- | ----------------- |
| `--sk-shadow-1`  | `0 1px 2px rgba(0,0,0,0.10)`           | `0 1px 2px rgba(0,0,0,0.08)`  | raised cells/rows |
| `--sk-shadow-2`  | `0 4px 14px rgba(0,0,0,0.14)`          | `0 4px 16px rgba(0,0,0,0.12)` | popovers, menus   |
| `--sk-shadow-3`  | `0 12px 36px rgba(0,0,0,0.22)`         | `0 12px 40px rgba(0,0,0,0.20)`| sheets, alerts    |

---

## 6. Motion

Keep motion quick and physical. Defaults:

- Duration: 150ms (small state changes), 250ms (surface enter/exit), 350ms (sheet).
- Easing: `cubic-bezier(0.32, 0.72, 0, 1)` for surfaces; `ease-out` for hovers.
- Respect `prefers-reduced-motion`: drop transforms, keep opacity fades.

Tokens: `--sk-ease-standard`, `--sk-duration-fast` (150ms),
`--sk-duration-medium` (250ms), `--sk-duration-slow` (350ms).

---

## 7. Token reference

The complete, canonical token set is
[`_tokens.scss`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/styles/_tokens.scss). That file is
the single source of truth; this section describes its shape rather than restating
the values, so the two can never drift.

Structure of `_tokens.scss`:

- Theme-varying tokens (accent hues, the gray ramp, the semantic
  label/fill/background/separator roles, and the glass tint) live in a `$themes`
  Sass map with `light` and `dark` entries. A single `emit-theme` mixin writes each
  entry as a `--sk-*` custom property, so the two themes stay structurally identical
  and never drift.
- Static tokens (`--sk-font-*`, `--sk-radius-*`, `--sk-space-*`, `--sk-shadow-*`,
  `--sk-ease-*`, `--sk-duration-*`, and `--sk-color-accent`) are declared once in
  `:root`.
- `_tokens.scss` is composed by
  [`index.scss`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/styles/index.scss) (with
  [`_fonts.scss`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/styles/_fonts.scss) and
  [`_base.scss`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/styles/_base.scss)), which
  `main.tsx` imports once.

Consuming tokens: reference the emitted custom properties, for example
`color: var(--sk-color-label)` or `border-radius: var(--sk-radius-lg)`. Never read
the Sass maps directly from component styles, and never hardcode a raw hex/px value.

Theme switching: set `data-theme="dark"` on the root element (the renderer defaults
to it via `index.html`). No attribute means light. A future enhancement can read the
OS theme and toggle this attribute.

---

## 8. Components and desktop adaptation

Each component lists its anatomy and the tokens it consumes. Only desktop-relevant
components are specified. Sizes assume the 14px base.

> For the implemented component kit and its API (props, variants, usage), see the
> companion [components.md](./components.md). The sections below describe design
> intent; the components in `shared/ui` are the source of truth.

### 8.1 Shared interaction states

Every interactive element defines four states. On desktop, hover and focus are
first-class (unlike touch).

- Rest: base tokens.
- Hover: overlay `--sk-color-fill-3`, or lift accent fill by ~8 percent.
- Active/pressed: overlay `--sk-color-fill-1`, optional `scale(0.98)`.
- Focus-visible: 2px outline in `--sk-color-accent` at 0.5 alpha, 2px offset. Always
  provide a keyboard focus ring; never remove outlines without a replacement.
- Disabled: content at `--sk-color-label-3`, no hover.

### 8.2 Buttons

Radius `--sk-radius-xl` (pill-like at default height 28-32px). Variants:

- Primary: fill `--sk-color-accent`, label white, `--sk-shadow-1`.
- Secondary: fill `--sk-color-fill-2`, label `--sk-color-label`.
- Tinted: accent-tinted fill (accent at ~16% alpha), label `--sk-color-accent`.
- Plain: no fill, label `--sk-color-accent`.
- Destructive: label or fill `--sk-red`.
- Glass: `--sk-glass-thin` surface with hairline border, for buttons over content.

Padding `--sk-space-3` vertical, `--sk-space-5` horizontal. Label weight 600,
`--sk-text-headline`. Icon-only buttons are square with `--sk-radius-pill`.

> Implemented. The reusable primitive is
> [`shared/ui/Button`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Button/Button.tsx)
> (`<Button variant="primary|secondary|plain|destructive|glass">`), with styles in
> the co-located `Button.scss`. Import it through the kit barrel: `@/shared/ui`.

**Glass treatment.** Any variant can also render on a glass surface via the
`glass` prop (`<Button variant="primary" glass>`): it overlays the translucent
tint, backdrop refraction, and gradient rim from Section 4 while keeping the
variant's role colour -- primary stays a frosted accent (theme-adaptive: a bright,
saturated accent on light, a lighter frosted tint on dark), secondary a neutral
frosted control. Disabled dims
the whole frosted surface so the inactive state reads at a glance.
`variant="glass"` remains the standalone accent-on-thin-glass look and already
implies the treatment. The split button below takes the same `glass` prop on its
shell.

**Split button.** A primary action joined to a chevron toggle that opens a
dropdown of related actions. The two segments share one rounded shell
(`--sk-radius-sm`, or `--sk-radius-xl` in the compact size that lines up flush
with round icon buttons), parted by a hairline `--sk-color-separator` divider.
Both segments use the secondary fill (`--sk-color-fill-2`, hover
`--sk-color-fill-1`) and the shared interaction states from 8.1; the chevron
points toward the primary action.

> Implemented as
> [`shared/ui/SplitButton`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/SplitButton/SplitButton.tsx)
> (`icon` / `tooltip` / `onPrimary` / `items` / `size`, plus `glass` for a
> frosted shell), opening the shared `Menu` (8.8) for its dropdown.

### 8.3 Controls

- Toggle: pill track (`--sk-radius-pill`), ~50x30px, knob is white circle with
  `--sk-shadow-1`; on = `--sk-green` track, off = `--sk-color-fill-1`. Animate knob
  with `--sk-duration-fast`.
- Segmented control: fully pill-shaped track `--sk-color-fill-2`
  (`--sk-radius-pill`); selected segment is a raised `--sk-color-bg-tertiary`
  capsule with `--sk-shadow-1`, also `--sk-radius-pill`. Equal-width segments.
- Slider: track 4px tall with `--sk-radius-pill`; filled portion `--sk-color-accent`,
  rest `--sk-color-fill-1`; knob is a 20px white circle with `--sk-shadow-2`.
- Stepper: two-segment glass/fill control with a separator; +/- glyphs in
  `--sk-color-label`.
- Interval stepper: a stepper paired with a minutes/hours segmented unit toggle
  for entering a duration; the value is stored in minutes and hours snap to whole
  hours. Implemented as `IntervalStepper` (composes `Stepper` +
  `SegmentedControl`).

### 8.4 Text fields

Fill `--sk-color-fill-3`, radius `--sk-radius-sm`, padding `--sk-space-3`
vertical / `--sk-space-4` horizontal. Placeholder `--sk-color-label-3`, text
`--sk-color-label`. Focus: hairline ring in `--sk-color-accent`. Optional leading
icon in `--sk-color-label-2`.

### 8.5 Lists and rows

- Row: min height 44px, padding `--sk-space-4`/`--sk-space-5`, label
  `--sk-text-body`. Trailing accessory (chevron, value, control) in
  `--sk-color-label-2`.
- Separator: `0.5px` `--sk-color-separator`, inset to the leading text edge.
- Grouped container: `--sk-radius-md` corners, `--sk-color-bg-tertiary` surface;
  first/last rows inherit container rounding.
- Section title: `--sk-text-footnote`, uppercase, `--sk-color-label-2`.
- Selected row (desktop): `--sk-color-accent` fill at full strength with white
  label, or `--sk-color-fill-2` for a quieter selection.
- Tree (outline): hierarchical rows indented by depth, each with a rotating
  chevron on branches, an optional leading glyph, a label, and a trailing
  detail/count. Rows use `--sk-radius-md`, hover `--sk-color-fill-3`, selected
  `--sk-color-fill-2`; branches expand with a jump-free height animation. Supports
  single-select or per-depth checkbox selection (tri-state branch checkboxes) and
  full arrow-key tree navigation.

> The tree is implemented as
> [`shared/ui/TreeView`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/TreeView/TreeView.tsx)
> (`TreeNode[]`; single-select via `selectedId`/`onSelect`, or `checkable`
> selection). Data tables use the companion `Table` primitive (8.12).

### 8.6 Sidebars

A `--sk-glass-regular` surface on the leading edge. Items use `--sk-radius-sm`,
`--sk-text-body`, leading icon in accent or `--sk-color-label-2`. Selected item:
`--sk-color-fill-2` (or accent for the active section). Section headers:
`--sk-text-footnote` in `--sk-color-label-2`. This is the primary navigation
surface for the desktop window.

> Implemented as a reusable component:
> [`shared/ui/Sidebar`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Sidebar/Sidebar.tsx)
> (`Sidebar` + `SidebarItem`, with an optional leading `Icon`). The app shell in
> [`app/App.tsx`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/app/App.tsx) composes it. The
> glass panel includes an opaque `@supports` fallback per Section 4.

### 8.7 Toolbars

A transparent header row at the top of a view, composed inside a `Page` via its
`toolbar` slot. Holds the page title (rendered as the screen `<h1>`), plus
leading and trailing controls (icon buttons, segmented controls,
primary/secondary actions). It carries no surface of its own, so it sits flush
with the page content; an optional bottom hairline (`--sk-color-separator`) is
available via the `separator` prop when a view wants a divider under the header.
Controls are vertically centred regardless of height.

> Implemented as [`shared/ui/Toolbar`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Toolbar/Toolbar.tsx)
> (`title` / `leading` / `trailing` / `separator`). Compose it through
> [`shared/ui/Page`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Page/Page.tsx)'s
> `toolbar` slot; see `SettingsPage`, `ProjectsPage`, and `RepositoriesPage`.

### 8.8 Menus and popovers

- Menu: `--sk-glass-thick` surface, `--sk-radius-lg`, `--sk-shadow-2`. Items 28px
  tall, `--sk-text-body`, hover fill `--sk-color-fill-3`, destructive items in
  `--sk-red`. Separators `0.5px`.
- Popover: `--sk-glass-regular`, `--sk-radius-xl`, `--sk-shadow-2`, with an optional
  arrow toward its anchor. Used for transient detail/edit panels.

> Implemented as [`shared/ui/Menu`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Menu/Menu.tsx):
> a portaled, window-aware floating list (single/multi/action items) that backs
> the app's dropdowns. Selection state is owned by the consumer.

### 8.9 Alerts and sheets

- Alert: centered `--sk-glass-thick` panel, `--sk-radius-2xl`, max width ~320px,
  `--sk-shadow-3`, dimmed scrim behind. Title `--sk-text-headline`, body
  `--sk-text-callout`, stacked or side-by-side buttons; default action weight 600.
- Sheet: a panel that animates in (slide/scale) over a dimmed scrim; on desktop,
  prefer a centered modal card (`--sk-radius-2xl`) rather than an edge-anchored
  drawer.

### 8.10 Progress

- Bar: 4px tall, `--sk-radius-pill`, fill `--sk-color-accent` over
  `--sk-color-fill-1`.
- Spinner/activity: accent or `--sk-color-label-2`; use for indeterminate waits.

> Spinner implemented as
> [`shared/ui/Spinner`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Spinner/Spinner.tsx)
> (`@/shared/ui`); the app shell uses it for the loading state. The animation is
> disabled under `prefers-reduced-motion` by the base layer.

### 8.11 Combobox

A text field paired with a filterable dropdown list. The input matches the text
field (8.4) -- `--sk-color-fill-3`, `--sk-radius-sm`, a focus hairline in
`--sk-color-accent`, and a trailing chevron in `--sk-color-label-2` -- and the
popup list matches the menu (8.8): a frosted glass surface, `--sk-radius-lg`,
`--sk-shadow-2`, portal-positioned and window-aware. Typing filters the options;
the active option takes `--sk-color-fill-3` and a selected option shows a leading
checkmark in `--sk-color-accent`. A multi-select variant keeps the list open
while several options are toggled.

> Implemented as
> [`shared/ui/Combobox`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Combobox/Combobox.tsx)
> (single value) and
> [`MultiCombobox`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/MultiCombobox/MultiCombobox.tsx)
> (multi). `MultiSelect` is the read-only-input sibling: a fixed-width trigger
> over a multi-select `Menu` listbox.

### 8.12 Table

A borderless data table for structured rows. Columns share one CSS grid track
template so the header and every row line up; there are no cell borders. The
header row is muted (`--sk-color-label-2`, `--sk-text-subhead`); body rows are
`--sk-radius-sm` with a `--sk-color-fill-3` hover and truncating cells. An
optional sticky header stays pinned while the body scrolls: it blurs the rows
sliding under it, and a small blurred fade at the bottom edge marks more content
below (both blend into `--sk-table-surface`, which defaults to
`--sk-color-bg-tertiary`). The fades degrade to nothing where `backdrop-filter`
is unavailable.

> Implemented as
> [`shared/ui/Table`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Table/Table.tsx)
> (`columns` / `rows`, optional `stickyHeader` + `maxBodyHeight`). See also the
> `TreeView` outline (8.5).

### 8.13 Tooltip

A small label revealed on hover/focus. The bubble inverts the surface --
`--sk-color-label` fill with `--sk-color-bg` text -- so it reads on any
background, at `--sk-radius-sm` with `--sk-shadow-2` and `--sk-text-subhead`. It
is portaled and positioned `fixed` on one of four sides (top / bottom / left /
right) with a cross-axis offset that keeps it inside the window near an edge, and
it sits above every other overlay. The reveal fades and scales from the anchored
edge.

> Implemented as
> [`shared/ui/Tooltip`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/Tooltip/Tooltip.tsx);
> sets `role="tooltip"` and wires `aria-describedby`.

### 8.14 Disclosure control

A header row with a rotating chevron that expands and collapses the content below
it. The trigger is a plain full-width button (`--sk-text-headline`, weight 600,
`--sk-color-label`) with a leading `--sk-color-label-2` chevron that rotates on
open; the content animates open with a jump-free height transition (a `0fr` to
`1fr` grid row, so there is no measured snap) over `--sk-duration-medium`. Wires
`aria-expanded` / `aria-controls`. Useful for advanced or secondary sections.

> Implemented as
> [`shared/ui/DisclosureGroup`](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/src/renderer/shared/ui/DisclosureGroup/DisclosureGroup.tsx)
> (`title` / `defaultOpen`).

### 8.15 Desktop adaptation rules

- Pointer first: every control has explicit hover and focus-visible states.
- Keyboard: full tab order, visible focus ring, Enter/Escape on dialogs, arrow-key
  navigation in lists and menus.
- Density: tighter than touch (28-32px controls, 44px rows) but keep generous
  padding inside glass surfaces.
- Window chrome: the top toolbar and leading sidebar are the persistent glass
  frame; content scrolls beneath them.
- Right-click: provide context menus (reuse the menu spec) where it adds value.
- No safe-area insets, no on-screen keyboard assumptions, no swipe-only actions
  (always provide a pointer/keyboard equivalent).

---

## 9. Out of scope

Patterns that are touch- or small-screen-specific are intentionally excluded from
this desktop system: on-screen keyboards, status/menu bars, bottom tab bars, page
indicator dots, edge-anchored drawers, and swipe-to-action rows. They may be
revisited only if the project ships a touch target.

---

## 10. Implementation notes

The foundation is wired and the existing renderer surfaces are migrated. The
`styles/` layer (`_tokens.scss`, `_fonts.scss`, `_base.scss`, `index.scss`) is
imported once from `main.tsx`; `index.html` defaults the renderer to the dark
theme. The app shell, the four pages, the config banner, and the `Button` / `Page`
/ `Spinner` primitives all run on tokens with co-located styles - no inline
hardcoded styles remain. The renderer follows the layered architecture in
[apps/desktop/docs/architecture.md](https://github.com/lorem-dev/skillkeeper/blob/main/apps/desktop/docs/architecture.md)
(`shared/ui` for the kit, `pages/` for screens, `app/` for the shell and store).

Standing rules:

1. Build components against semantic tokens only (`var(--sk-*)`); never hardcode
   hex/px values.
2. Co-locate component styles with the component (for example `App.scss` beside
   `App.tsx`), imported from that component's module. Only global foundations live
   in `styles/`.
3. Reusable, product-agnostic primitives live in `shared/ui` behind the
   `@/shared/ui` barrel; screen-specific composition lives in `pages/` (and, as the
   product grows, `entities/` and `features/`).
4. When adding glass surfaces, verify `backdrop-filter` works under the app's CSP
   and provide the opaque fallback from Section 4.
5. `_tokens.scss` is the single source of truth. When a token changes, edit the
   SCSS first, then update the explanatory tables here to match - never the other
   way around.
