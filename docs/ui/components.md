# SkillKeeper UI Components

Status: draft (v0.1)
Scope: the generic component kit in `apps/desktop/src/renderer/shared/ui`.

This is the API reference for the reusable renderer components. It is a companion
to [design-system.md](./design-system.md): the design doc defines the visual
language and tokens (the *what it looks like*), this doc lists the implemented
components and their props (the *how to use it*). The components are the source of
truth; this catalog points at them.

## Conventions

- **Import through the kit barrel:** `import { Button, Select } from '@/shared/ui'`.
  Never deep-import a component file.
- **Tokens only.** Every component styles itself with `--sk-*` custom properties
  (see design-system.md). No hardcoded colors or sizes.
- **Co-located styles.** Each component has a sibling `.scss` file; global
  foundations live in `styles/`.
- **i18n via props.** Shared components carry no translation logic (they cannot
  import `@/systems/i18n`). Pass already-translated strings in (e.g.
  `label={t('common.loading')}`). See the architecture doc's Internationalization
  section.
- **Accessibility.** Form controls wrap native inputs (kept focusable); overlays
  set the right roles (`tooltip`, `dialog`, `progressbar`, `radiogroup`). Every
  interactive element has a visible `:focus-visible` ring.

## Animation

State and presence transitions use [Framer Motion](https://motion.dev) (the
`motion` package). Shared presets live in
[`shared/lib/transitions.ts`](../../apps/desktop/src/renderer/shared/lib/transitions.ts)
(`fade`, `fadeScale`, `fadeRise`, `collapse`, plus `SK_EASE` / `SK_DURATION` that
mirror the CSS motion tokens). Simple state changes (hover, checked, focus) stay in
CSS transitions for weight; Framer Motion is used where CSS cannot help -- enter and
exit (`AnimatePresence`) and shared-layout moves:

- `SegmentedControl` -- the selected pill slides between segments (`layoutId`).
- `Tooltip`, `Modal` -- fade/scale and rise on mount, animate out on unmount.
- `Alert` -- collapses its height on exit (wrap in `<AnimatePresence>`).

Framer Motion honors `prefers-reduced-motion`; CSS animations are disabled under it
by the base layer.

---

## Layout and structure

### Page
`<Page title={...}>children</Page>` -- a titled content column. Outer padding comes
from the app shell's content area.
Source: [shared/ui/Page/Page.tsx](../../apps/desktop/src/renderer/shared/ui/Page/Page.tsx)

### Card
`<Card glass?>children</Card>` -- a rounded surface for grouping content. `glass`
switches to a translucent material (with an opaque fallback).
Source: [shared/ui/Card/Card.tsx](../../apps/desktop/src/renderer/shared/ui/Card/Card.tsx)

### Divider
`<Divider />` -- a hairline separator.
Source: [shared/ui/Divider/Divider.tsx](../../apps/desktop/src/renderer/shared/ui/Divider/Divider.tsx)

### GlassSurface
`<GlassSurface depth? strength? blur? chromaticAberration? borderBrightness?>children</GlassSurface>`
-- a translucent panel whose backdrop is refracted like glass, with the
displacement concentrated at the rim so the edge reads as a rounded glass lens,
plus a directional rim shine. `borderBrightness` (default 1) scales the rim
border's opacity -- lower (e.g. 0.5) dims it, higher intensifies it. The refraction is applied by the `useGlassRefraction`
hook (`@/shared/lib`) via a per-element SVG displacement filter in
`backdrop-filter` (re-measured on resize); the surface clips it to the rounded
shape (`overflow: hidden`) for a clean edge and a thin gradient rim border (bright
at the top-left/bottom-right corners, fading elsewhere). **Falls back** to plain
blur+saturate where `backdrop-filter: url()` is
unsupported. The Card `glass` variant uses the same hook. The refraction is most
visible over detailed/high-contrast backdrops; over flat color it stays subtle.
See design-system.md Section 4.
Source: [shared/ui/GlassSurface/GlassSurface.tsx](../../apps/desktop/src/renderer/shared/ui/GlassSurface/GlassSurface.tsx)

### Toolbar
`<Toolbar title leading trailing />` -- a glass bar with leading controls, a title,
and trailing actions (design-system.md 8.7).
Source: [shared/ui/Toolbar/Toolbar.tsx](../../apps/desktop/src/renderer/shared/ui/Toolbar/Toolbar.tsx)

### Sidebar / SidebarItem
`<Sidebar title?>` is the leading-edge glass navigation panel; `<SidebarItem icon?
active? onClick>label</SidebarItem>` is a nav row with an optional leading icon and
an active state. Design-system.md 8.6.
Source: [shared/ui/Sidebar](../../apps/desktop/src/renderer/shared/ui/Sidebar/Sidebar.tsx)

```tsx
<Sidebar title="SkillKeeper">
  {items.map((it) => (
    <SidebarItem key={it.id} icon={<Icon name={it.icon} />} active={active === it.id}
      onClick={() => setActive(it.id)}>{it.label}</SidebarItem>
  ))}
</Sidebar>
```

### Icon
`<Icon name size? label? />` -- a named line icon (inline SVG, 24x24, `currentColor`,
stroke-based). Names: `repositories`, `skills`, `projects`, `settings`, `search`,
`plus`, `check`, `chevron-right`. Decorative by default; pass `label` for an
accessible name.
Source: [shared/ui/Icon/Icon.tsx](../../apps/desktop/src/renderer/shared/ui/Icon/Icon.tsx)

### List / ListRow
`<List>` is a grouped, rounded surface with hairline separators; `<ListRow>` has
`leading` / `title` + `subtitle` / `trailing` slots and becomes a button when given
`onClick` (with a `selected` state). Design-system.md 8.5.
Source: [shared/ui/List](../../apps/desktop/src/renderer/shared/ui/List/ListRow.tsx)

### FormSection / FormRow
The inset-grouped form layout. `<FormSection title? footer?>` stacks rows on a
rounded surface with hairline separators (header + footer outside the card).
`<FormRow label description? htmlFor? align?>` puts the label/description on the
leading edge and the control (children) on the trailing edge -- drop any control
in and it aligns automatically. Design-system.md 8.5.
Source: [shared/ui/Form](../../apps/desktop/src/renderer/shared/ui/Form/FormRow.tsx)

```tsx
<FormSection title="General" footer="Applies to every project.">
  <FormRow label="Enable hooks" description="Ask before installing">
    <Toggle checked={on} onChange={(e) => setOn(e.target.checked)} />
  </FormRow>
  <FormRow label="Language">
    <Select value={lang} onChange={...} options={langs} />
  </FormRow>
</FormSection>
```

### DisclosureGroup
`<DisclosureGroup title defaultOpen?>children</DisclosureGroup>` -- a header with a
rotating chevron that expands/collapses its content (animated height + chevron
rotation). Wires `aria-expanded` / `aria-controls`. A desktop pattern (disclosure
control) useful for advanced/collapsible sections.
Source: [shared/ui/DisclosureGroup/DisclosureGroup.tsx](../../apps/desktop/src/renderer/shared/ui/DisclosureGroup/DisclosureGroup.tsx)

```tsx
<List>
  {repos.map((r) => (
    <ListRow key={r.id} title={r.name} subtitle={r.url} onClick={() => open(r)} />
  ))}
</List>
```

### Row
`<Row align? justify? gap? wrap?>children</Row>` -- a horizontal flex layout
primitive. Arranges children in a row with a token-based `gap` (a `--sk-space-N`
step, 1-8) and configurable `align` (`start` | `center` | `end` | `stretch` |
`baseline`) / `justify` (`start` | `center` | `end` | `between`); `wrap` allows
multiple lines.
Source: [shared/ui/Row/Row.tsx](../../apps/desktop/src/renderer/shared/ui/Row/Row.tsx)

### Table
`<Table columns rows stickyHeader? maxBodyHeight? emptyText? ariaLabel? />` -- a
borderless, grid-aligned data table. `columns: { key, header, width?, align? }[]`
share one CSS grid track template so the header and every row line up;
`rows: { id, cells }[]` with `cells` index-aligned to `columns`. With
`stickyHeader` + `maxBodyHeight` the header stays pinned while the body scrolls
(rows blur under it, a blurred fade marks more content below). Design-system.md
8.12.
Source: [shared/ui/Table/Table.tsx](../../apps/desktop/src/renderer/shared/ui/Table/Table.tsx)

### TreeView
`<TreeView nodes selectedId? onSelect? defaultExpandedIds? checkable?
checkboxLevels? checkedIds? onCheckedChange? ariaLabel? />` -- a hierarchical
outline of indented, collapsible rows. `nodes: TreeNode[]` where a node with
`children` is an expandable branch (each node has `label`, optional `icon`,
`detail`/`trailing`, `muted`, `selectable`). Single-select
(`selectedId`/`onSelect`) or checkbox selection (`checkable`, scoped per depth
via `checkboxLevels`, `checkedIds`/`onCheckedChange`, with tri-state branch
checkboxes). Full arrow-key tree navigation. Design-system.md 8.5.
Source: [shared/ui/TreeView/TreeView.tsx](../../apps/desktop/src/renderer/shared/ui/TreeView/TreeView.tsx)

---

## Controls

### Button
`<Button variant glass? loading?>` -- `variant`: `primary` | `secondary`
(default) | `tinted` | `plain` | `destructive` | `glass`. `glass` overlays the
refractive glass-surface treatment on top of any variant (a frosted primary,
secondary, etc.); `loading` shows a shimmer and disables the button. Forwards all
native button attributes. Design-system.md 8.2.
Source: [shared/ui/Button/Button.tsx](../../apps/desktop/src/renderer/shared/ui/Button/Button.tsx)

### Checkbox
`<Checkbox label? />` -- native checkbox with a styled box. Forwards native input
attributes (`checked`, `onChange`, `disabled`, ...).
Source: [shared/ui/Checkbox/Checkbox.tsx](../../apps/desktop/src/renderer/shared/ui/Checkbox/Checkbox.tsx)

### Toggle
`<Toggle label? />` -- a switch (native checkbox, `role="switch"`) styled as a pill
track with a sliding knob; on = green. Design-system.md 8.3.
Source: [shared/ui/Toggle/Toggle.tsx](../../apps/desktop/src/renderer/shared/ui/Toggle/Toggle.tsx)

### RadioGroup
`<RadioGroup name value options onChange label? />` -- controlled single choice;
`options: { value, label, disabled? }[]`.
Source: [shared/ui/RadioGroup/RadioGroup.tsx](../../apps/desktop/src/renderer/shared/ui/RadioGroup/RadioGroup.tsx)

### SegmentedControl
`<SegmentedControl options value onChange label? />` -- single choice as a segmented
bar; the selected pill slides between segments. Design-system.md 8.3.
Source: [shared/ui/SegmentedControl/SegmentedControl.tsx](../../apps/desktop/src/renderer/shared/ui/SegmentedControl/SegmentedControl.tsx)

### TextField
`<TextField label? invalid? />` -- single-line input; forwards native input
attributes; `invalid` adds a red border + `aria-invalid`. Design-system.md 8.4.
Source: [shared/ui/TextField/TextField.tsx](../../apps/desktop/src/renderer/shared/ui/TextField/TextField.tsx)

### Select
`<Select label? options? />` -- styled native select with a custom chevron; pass
`options: { value, label, disabled? }[]` or `<option>` children.
Source: [shared/ui/Select/Select.tsx](../../apps/desktop/src/renderer/shared/ui/Select/Select.tsx)

### SearchField
`<SearchField value onChange onClear? clearLabel? />` -- a pill input with a
leading magnifier and a trailing clear button (shown when controlled with a
non-empty value). Pass a translated `clearLabel`. A desktop pattern.
Source: [shared/ui/SearchField/SearchField.tsx](../../apps/desktop/src/renderer/shared/ui/SearchField/SearchField.tsx)

### Slider
`<Slider />` -- styled native range input; forwards native input attributes
(`min`, `max`, `step`, `value`, `onChange`). Design-system.md 8.3.
Source: [shared/ui/Slider/Slider.tsx](../../apps/desktop/src/renderer/shared/ui/Slider/Slider.tsx)

### Stepper
`<Stepper value onChange min? max? step? />` -- numeric value with decrement /
increment buttons. Button accessible names come from `decreaseLabel` /
`increaseLabel` (pass translated strings). Design-system.md 8.3.
Source: [shared/ui/Stepper/Stepper.tsx](../../apps/desktop/src/renderer/shared/ui/Stepper/Stepper.tsx)

### IntervalStepper
`<IntervalStepper minutes onChange minMinutes? maxMinutes? label? minutesUnitLabel?
hoursUnitLabel? decreaseLabel? increaseLabel? disabled? />` -- pick a duration as
a `Stepper` value plus a minutes/hours `SegmentedControl` unit. The stored value
is always minutes (switching to hours snaps to whole hours), clamped to
`[minMinutes, maxMinutes]`. Pass translated unit and button labels.
Design-system.md 8.3.
Source: [shared/ui/IntervalStepper/IntervalStepper.tsx](../../apps/desktop/src/renderer/shared/ui/IntervalStepper/IntervalStepper.tsx)

### Combobox
`<Combobox options value onChange label? placeholder? emptyText? maxLabelLength?
ariaLabel? disabled? />` -- a text input paired with a filterable dropdown list;
typing filters `options: { value, label, icon?, disabled? }[]` and the selection
commits a single `value`. An option's `icon` shows in its list row and, for the
selected option, as a leading adornment in the input; `fallbackIcon` fills that
leading slot while nothing is committed or the user is typing. The input matches the text
field / select trigger; the list matches the Menu (glass, portal-positioned,
window-aware). `maxLabelLength` truncates the displayed label only.
Design-system.md 8.11.
Source: [shared/ui/Combobox/Combobox.tsx](../../apps/desktop/src/renderer/shared/ui/Combobox/Combobox.tsx)

### MultiCombobox
`<MultiCombobox options value onChange label? placeholder? emptyText? ariaLabel?
disabled? />` -- like Combobox but multi-select: `value: string[]`; the list stays
open while several options are toggled (a leading checkmark marks each selected).
When idle the input shows the joined selected labels. Design-system.md 8.11.
Source: [shared/ui/MultiCombobox/MultiCombobox.tsx](../../apps/desktop/src/renderer/shared/ui/MultiCombobox/MultiCombobox.tsx)

### MultiSelect
`<MultiSelect options value onChange placeholder? summary? ariaLabel? disabled? />`
-- a fixed-width pop-up trigger showing the selected labels, opening a Menu as a
multi-selectable listbox. When the joined labels overflow the trigger it falls
back to a caller-supplied `summary(count)` string (e.g. `(n) => "Selected " + n`).
Design-system.md 8.11.
Source: [shared/ui/MultiSelect/MultiSelect.tsx](../../apps/desktop/src/renderer/shared/ui/MultiSelect/MultiSelect.tsx)

### SplitButton
`<SplitButton icon? tooltip onPrimary items menuLabel size? glass? disabled? />`
-- a primary action button joined to a chevron toggle that opens a dropdown Menu
of related actions (`items: { id, label, icon?, onSelect }[]`). `size`: `default`
| `compact` (matches the round icon buttons); `glass` frosts the shell.
Design-system.md 8.2.
Source: [shared/ui/SplitButton/SplitButton.tsx](../../apps/desktop/src/renderer/shared/ui/SplitButton/SplitButton.tsx)

---

## Feedback and content

### Badge
`<Badge tone>` -- a status pill; `tone`: `neutral` (default) | `accent` | `success`
| `warning` | `danger`.
Source: [shared/ui/Badge/Badge.tsx](../../apps/desktop/src/renderer/shared/ui/Badge/Badge.tsx)

### Spinner
`<Spinner label? />` -- indeterminate activity ring with a status label.
Design-system.md 8.10.
Source: [shared/ui/Spinner/Spinner.tsx](../../apps/desktop/src/renderer/shared/ui/Spinner/Spinner.tsx)

### ProgressBar
`<ProgressBar value? label? />` -- determinate when `value` (0..1) is given,
indeterminate when omitted. Design-system.md 8.10.
Source: [shared/ui/ProgressBar/ProgressBar.tsx](../../apps/desktop/src/renderer/shared/ui/ProgressBar/ProgressBar.tsx)

### Skeleton
`<Skeleton width? height? radius? />` -- shimmering loading placeholder
(decorative; hidden from assistive tech).
Source: [shared/ui/Skeleton/Skeleton.tsx](../../apps/desktop/src/renderer/shared/ui/Skeleton/Skeleton.tsx)

### Tooltip
`<Tooltip content>trigger</Tooltip>` -- shows a label on hover/focus; animated
in/out. Sets `role="tooltip"` and wires `aria-describedby`.
Source: [shared/ui/Tooltip/Tooltip.tsx](../../apps/desktop/src/renderer/shared/ui/Tooltip/Tooltip.tsx)

### Alert
`<Alert tone title?>children</Alert>` -- inline message surface; `tone`: `info`
(default) | `success` | `warning` | `danger`. A tone-tinted glass surface: the
backdrop is frosted (useGlassRefraction) and the tone color is blended into the
translucent glass tint, with a solid fallback where backdrop-filter is absent.
Animates its height; wrap in `<AnimatePresence>` for a smooth dismiss.
Design-system.md 8.9.
Source: [shared/ui/Alert/Alert.tsx](../../apps/desktop/src/renderer/shared/ui/Alert/Alert.tsx)

### Modal
`<Modal open onClose title?>children</Modal>` -- portal dialog over a dimmed scrim;
fades/rises in, closes on Escape or scrim click. Sets `role="dialog"` +
`aria-modal`. Design-system.md 8.9.
Source: [shared/ui/Modal/Modal.tsx](../../apps/desktop/src/renderer/shared/ui/Modal/Modal.tsx)

```tsx
const [open, setOpen] = useState(false);
<Button variant="primary" onClick={() => setOpen(true)}>Open</Button>
<Modal open={open} onClose={() => setOpen(false)} title="Confirm">
  ...
</Modal>
```

### Menu
`<Menu open onClose anchorRef items closeOnSelect? placement? role? multiselectable?
ariaLabel? />` -- a portaled, window-aware floating glass list that positions
against `anchorRef` and backs the app's dropdowns. `items: { id, label, icon?,
selected?, disabled?, onSelect }[]`; `role`: `menu` (actions / checkables,
default) | `listbox` (selects). `placement` (`auto` default) flips to fit the
window. Full keyboard navigation; selection state is owned by the consumer.
Design-system.md 8.8.
Source: [shared/ui/Menu/Menu.tsx](../../apps/desktop/src/renderer/shared/ui/Menu/Menu.tsx)

### ChangeBadge
`<ChangeBadge kind label />` -- a small filled circle with a knocked-out glyph
previewing a pending change; `kind`: `add` (green, `+`) | `remove` (red, `-`) |
`present` (gray, check). The glyph is a true SVG-mask knockout so it reads on any
row background. Wrapped in a Tooltip with `label` (also the accessible name).
Source: [shared/ui/ChangeBadge/ChangeBadge.tsx](../../apps/desktop/src/renderer/shared/ui/ChangeBadge/ChangeBadge.tsx)

### SearchSummary
`<SearchSummary foundLabel totalLabel showAllLabel onShowAll />` -- a footer shown
below a filtered list: a "found N / M total" summary and a button that clears the
active search. All strings are passed in already translated and plural-aware.
Source: [shared/ui/SearchSummary/SearchSummary.tsx](../../apps/desktop/src/renderer/shared/ui/SearchSummary/SearchSummary.tsx)
