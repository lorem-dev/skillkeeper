/**
 * TreeView: an inline, expandable outline (source-list) for hierarchical data
 * such as repositories -> skill groups -> skills, or projects -> installed
 * skills. Generic -- no product knowledge; the caller supplies node icons and
 * detail text as ReactNodes.
 *
 * Each node with children is a branch with a rotating chevron; expanding uses
 * the jump-free `grid-template-rows: 0fr -> 1fr` technique (as DisclosureGroup),
 * so there is no height measurement and no snap. Selection is single: exactly
 * one node -- a leaf or a whole branch ("folder") -- can be selected. Nodes with
 * `selectable: false` (typically the root repository/project) cannot be
 * selected; clicking them only toggles their branch.
 *
 * Checkbox mode (`checkable`): a trailing checkbox selects nodes. Which levels
 * show a checkbox is controlled by `checkboxLevels` (all levels by default). A
 * branch's checkbox is tri-state -- checked when all of its descendant leaves
 * are checked, "mixed" (a dash) when only some are, unchecked otherwise;
 * toggling it checks/unchecks all of them. `checkedIds` (the checked leaves) is
 * controlled via `onCheckedChange`. In this mode clicking a branch row toggles
 * its expansion (not selection), and clicking a leaf row toggles its checkbox --
 * unless that leaf sets its own `trailing` control (e.g. an MCP row's
 * Install/Remove badge), in which case it never gets a checkbox and is left out
 * of every ancestor's tri-state count; it renders the reserved spacer instead.
 *
 * Keyboard (roving tabindex, WAI-ARIA tree pattern): Up/Down move between
 * visible rows, Right expands then steps into a branch, Left collapses then
 * steps out to the parent, Enter activates the row (select, or expand in
 * checkbox mode), Space toggles the checkbox in checkbox mode, Home/End jump to
 * the first/last visible row.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cx, fade, SK_DURATION, SK_EASE } from '../../lib';
import { Checkbox } from '../Checkbox';
import './TreeView.scss';

export interface TreeNode {
  readonly id: string;
  readonly label: ReactNode;
  /** Leading glyph, e.g. `<Icon name="folder" />`. */
  readonly icon?: ReactNode;
  /** Trailing detail, e.g. a count. */
  readonly detail?: ReactNode;
  /** Trailing control in the detail column; overrides the auto count when set. */
  readonly trailing?: ReactNode;
  /** Child nodes; presence makes this an expandable branch. */
  readonly children?: readonly TreeNode[];
  /** Defaults to true. Set false (e.g. for a root) to make the row non-selectable. */
  readonly selectable?: boolean;
  /** Dim the row (e.g. an orphaned skill whose source is gone). */
  readonly muted?: boolean;
}

export interface TreeViewProps {
  readonly nodes: readonly TreeNode[];
  /** Currently selected node id, or null. Controlled. */
  readonly selectedId?: string | null;
  /** Called with the node when a selectable row is activated. */
  readonly onSelect?: (node: TreeNode) => void;
  /** Ids expanded on first render. */
  readonly defaultExpandedIds?: readonly string[];
  /**
   * Called with the full current expanded-id array whenever the USER changes
   * expansion (row/chevron click, or a keyboard toggle). Not fired for the
   * programmatic `defaultExpandedIds` merge (e.g. search auto-expand).
   */
  readonly onExpandedChange?: (expandedIds: string[]) => void;
  /** Accessible name for the tree. */
  readonly ariaLabel?: string;
  /** Turn on checkbox selection. */
  readonly checkable?: boolean;
  /**
   * Depths (0-based) that render a checkbox. Defaults to every level when
   * `checkable` is on. Use e.g. `[1, 2]` to show checkboxes on groups and
   * skills but not the repository/project root.
   */
  readonly checkboxLevels?: readonly number[];
  /** Checked leaf ids. Controlled. */
  readonly checkedIds?: readonly string[];
  /** Called with the next full set of checked leaf ids after a toggle. */
  readonly onCheckedChange?: (checkedIds: string[]) => void;
  readonly className?: string;
}

interface FlatItem {
  readonly node: TreeNode;
  readonly depth: number;
  readonly parentId: string | null;
  readonly hasChildren: boolean;
}

/** Depth-first list of the rows currently visible (respecting expansion). */
function flattenVisible(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId: string | null = null,
  acc: FlatItem[] = [],
): FlatItem[] {
  for (const node of nodes) {
    const hasChildren = node.children !== undefined && node.children.length > 0;
    acc.push({ node, depth, parentId, hasChildren });
    if (hasChildren && expanded.has(node.id)) {
      flattenVisible(node.children!, expanded, depth + 1, node.id, acc);
    }
  }
  return acc;
}

export function TreeView({
  nodes,
  selectedId = null,
  onSelect,
  defaultExpandedIds,
  onExpandedChange,
  ariaLabel,
  checkable = false,
  checkboxLevels,
  checkedIds,
  onCheckedChange,
  className,
}: TreeViewProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );
  const [focusedId, setFocusedId] = useState<string | null>(nodes[0]?.id ?? null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // When the caller changes which ids should be open (e.g. expand matches while
  // searching), merge them into the open set -- without collapsing anything the
  // user opened, and without re-running on every render (only on a real change).
  const expandKey = (defaultExpandedIds ?? []).join(' ');
  const prevExpandKey = useRef(expandKey);
  useEffect(() => {
    if (expandKey === prevExpandKey.current) return;
    prevExpandKey.current = expandKey;
    if (defaultExpandedIds !== undefined && defaultExpandedIds.length > 0) {
      setExpanded((prev) => new Set([...prev, ...defaultExpandedIds]));
    }
  }, [expandKey, defaultExpandedIds]);

  const visible = useMemo(() => flattenVisible(nodes, expanded), [nodes, expanded]);
  const checkedSet = useMemo(() => new Set(checkedIds ?? []), [checkedIds]);

  function checkboxAtDepth(depth: number): boolean {
    return checkable && (checkboxLevels === undefined || checkboxLevels.includes(depth));
  }

  // A node's controllable leaves: the checkbox-bearing leaves in its subtree
  // (itself, if it is such a leaf). A leaf with its own `trailing` control (e.g.
  // an MCP row's Install/Remove badge) opts out of the checkbox entirely -- it
  // is not a checkable item, so it is excluded here too, keeping it out of an
  // ancestor branch's tri-state count as well as its own checkbox toggle.
  function checkableLeaves(node: TreeNode, depth: number, acc: string[] = []): string[] {
    const kids = node.children;
    if (kids === undefined || kids.length === 0) {
      if (checkboxAtDepth(depth) && node.trailing === undefined) acc.push(node.id);
      return acc;
    }
    for (const child of kids) checkableLeaves(child, depth + 1, acc);
    return acc;
  }

  type CheckState = 'checked' | 'unchecked' | 'indeterminate';

  function checkStateFor(node: TreeNode, depth: number): CheckState | null {
    if (!checkboxAtDepth(depth)) return null;
    const hasChildren = node.children !== undefined && node.children.length > 0;
    if (!hasChildren) return node.trailing !== undefined ? null : (checkedSet.has(node.id) ? 'checked' : 'unchecked');
    const leaves = checkableLeaves(node, depth);
    if (leaves.length === 0) return 'unchecked';
    let checkedCount = 0;
    for (const id of leaves) if (checkedSet.has(id)) checkedCount += 1;
    if (checkedCount === 0) return 'unchecked';
    if (checkedCount === leaves.length) return 'checked';
    return 'indeterminate';
  }

  function toggleCheck(node: TreeNode, depth: number): void {
    const targets = checkableLeaves(node, depth);
    if (targets.length === 0) return;
    const next = new Set(checkedSet);
    const allChecked = targets.every((id) => next.has(id));
    for (const id of targets) {
      if (allChecked) next.delete(id);
      else next.add(id);
    }
    onCheckedChange?.([...next]);
  }

  // The trailing count. In checkbox mode a branch shows its selection: "N/M"
  // with N in the checkbox accent, "M" (accent) when all are selected, or a
  // plain "M" when none are. Otherwise the caller's `detail` is shown as-is.
  function renderCount(node: TreeNode, depth: number, hasChildren: boolean): ReactNode {
    // A node-supplied trailing control wins over the auto count/detail.
    if (node.trailing !== undefined) {
      return <span className="sk-tree__trailing">{node.trailing}</span>;
    }
    if (checkable && hasChildren) {
      const leaves = checkableLeaves(node, depth);
      const total = leaves.length;
      if (total > 0) {
        let selected = 0;
        for (const id of leaves) if (checkedSet.has(id)) selected += 1;
        if (selected === 0) return <span className="sk-tree__count">{total}</span>;
        if (selected === total) {
          return <span className="sk-tree__count sk-tree__count--all">{total}</span>;
        }
        return (
          <span className="sk-tree__count">
            <span className="sk-tree__count-selected">{selected}</span>/{total}
          </span>
        );
      }
    }
    if (node.detail !== undefined) return <span className="sk-tree__detail">{node.detail}</span>;
    return null;
  }

  // Exactly one row is in the tab order (roving tabindex). Fall back to the
  // first visible row when the remembered one has scrolled out of existence.
  const activeId = visible.some((v) => v.node.id === focusedId)
    ? focusedId
    : (visible[0]?.node.id ?? null);

  // Single funnel for every USER-driven expansion change (row/chevron click,
  // keyboard toggles) -- notifies `onExpandedChange` with the full next set.
  // The programmatic `defaultExpandedIds` merge effect above does NOT go
  // through this (it calls `setExpanded` directly), since that is a
  // search-driven auto-expand, not a user action.
  function commitExpanded(next: ReadonlySet<string>): void {
    setExpanded(next);
    onExpandedChange?.([...next]);
  }

  function setBranch(id: string, open: boolean): void {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    commitExpanded(next);
  }

  function toggle(id: string): void {
    setBranch(id, !expanded.has(id));
  }

  function focusRow(id: string): void {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function activateRow(node: TreeNode, depth: number, hasChildren: boolean): void {
    setFocusedId(node.id);
    if (checkable) {
      // Selection is via the checkbox: a branch row toggles expansion, a leaf
      // row toggles its own checkbox.
      if (hasChildren) toggle(node.id);
      else toggleCheck(node, depth);
      return;
    }
    if (node.selectable !== false) onSelect?.(node);
    else if (hasChildren) toggle(node.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>, id: string): void {
    const idx = visible.findIndex((v) => v.node.id === id);
    if (idx === -1) return;
    const item = visible[idx]!;
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const n = visible[idx + 1];
        if (n !== undefined) focusRow(n.node.id);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const p = visible[idx - 1];
        if (p !== undefined) focusRow(p.node.id);
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        if (!item.hasChildren) break;
        if (!expanded.has(id)) setBranch(id, true);
        else {
          const child = visible[idx + 1];
          if (child !== undefined && child.parentId === id) focusRow(child.node.id);
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (item.hasChildren && expanded.has(id)) setBranch(id, false);
        else if (item.parentId !== null) focusRow(item.parentId);
        break;
      }
      case 'Enter': {
        e.preventDefault();
        activateRow(item.node, item.depth, item.hasChildren);
        break;
      }
      case ' ': {
        e.preventDefault();
        // Space toggles the checkbox when this row has one; otherwise it mirrors
        // Enter (select, or expand a branch).
        if (checkboxAtDepth(item.depth)) toggleCheck(item.node, item.depth);
        else activateRow(item.node, item.depth, item.hasChildren);
        break;
      }
      case 'Home': {
        e.preventDefault();
        if (visible[0] !== undefined) focusRow(visible[0].node.id);
        break;
      }
      case 'End': {
        e.preventDefault();
        const last = visible[visible.length - 1];
        if (last !== undefined) focusRow(last.node.id);
        break;
      }
      default:
        break;
    }
  }

  function renderItem(node: TreeNode, depth: number): ReactNode {
    const hasChildren = node.children !== undefined && node.children.length > 0;
    const isOpen = expanded.has(node.id);
    const selectable = node.selectable !== false;
    // Highlight selection only outside checkbox mode; there, state lives on the
    // checkbox (and aria-checked) instead.
    const isSelected = !checkable && selectable && selectedId === node.id;
    const checkState = checkStateFor(node, depth);
    // The label truncates to the available width (CSS ellipsis); keep the full
    // string in the tooltip so a clipped label is still discoverable.
    const labelText = typeof node.label === 'string' ? node.label : undefined;

    return (
      <motion.li
        key={node.id}
        variants={fade}
        initial="initial"
        animate="animate"
        exit="exit"
        role="treeitem"
        aria-expanded={hasChildren ? isOpen : undefined}
        aria-selected={!checkable && selectable ? isSelected : undefined}
        aria-checked={
          checkState === null ? undefined : checkState === 'indeterminate' ? 'mixed' : checkState === 'checked'
        }
        className="sk-tree__item"
      >
        <div
          ref={(el) => {
            if (el !== null) rowRefs.current.set(node.id, el);
            else rowRefs.current.delete(node.id);
          }}
          className={cx(
            'sk-tree__row',
            isSelected && 'sk-tree__row--selected',
            !selectable && 'sk-tree__row--plain',
            node.muted === true && 'sk-tree__row--muted',
          )}
          style={{ '--sk-tree-depth': depth } as CSSProperties}
          tabIndex={node.id === activeId ? 0 : -1}
          onClick={() => activateRow(node, depth, hasChildren)}
          onKeyDown={(e) => onKeyDown(e, node.id)}
        >
          {hasChildren ? (
            <span
              className="sk-tree__chevron"
              aria-hidden="true"
              // Mouse: toggle only, without also selecting the row.
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.id);
              }}
            >
              <motion.span
                className="sk-tree__chevron-glyph"
                animate={{ rotate: isOpen ? 0 : -90 }}
                transition={{ duration: SK_DURATION.fast, ease: SK_EASE }}
              >
                <svg viewBox="0 0 12 12">
                  <path
                    d="M3 4.5 L6 7.5 L9 4.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </motion.span>
            </span>
          ) : (
            <span className="sk-tree__chevron sk-tree__chevron--spacer" aria-hidden="true" />
          )}
          {node.icon !== undefined && <span className="sk-tree__icon">{node.icon}</span>}
          <span className="sk-tree__label" title={labelText}>
            {node.label}
          </span>
          {renderCount(node, depth, hasChildren)}
          {checkable &&
            (checkState !== null ? (
              // Checkbox on the right. The treeitem carries aria-checked, so the
              // inner input is hidden from AT and out of the tab order (Space on
              // the row toggles it). Stop the click so the row handler does not
              // also fire.
              <span
                className="sk-tree__checkbox"
                aria-hidden="true"
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  tabIndex={-1}
                  checked={checkState === 'checked'}
                  indeterminate={checkState === 'indeterminate'}
                  onChange={() => toggleCheck(node, depth)}
                />
              </span>
            ) : (
              // Reserve the checkbox column on rows without one (e.g. the root),
              // so counts line up in a column and checkboxes stay aligned.
              <span className="sk-tree__checkbox sk-tree__checkbox--spacer" aria-hidden="true" />
            ))}
        </div>
        {hasChildren && (
          <div className={cx('sk-tree__wrap', isOpen && 'sk-tree__wrap--open')} inert={!isOpen}>
            <div className="sk-tree__inner">
              <ul className="sk-tree__group" role="group">
                <AnimatePresence initial={false} mode="popLayout">
                  {node.children!.map((child) => renderItem(child, depth + 1))}
                </AnimatePresence>
              </ul>
            </div>
          </div>
        )}
      </motion.li>
    );
  }

  return (
    <ul
      className={cx('sk-tree', className)}
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable={checkable ? true : undefined}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {nodes.map((node) => renderItem(node, 0))}
      </AnimatePresence>
    </ul>
  );
}
