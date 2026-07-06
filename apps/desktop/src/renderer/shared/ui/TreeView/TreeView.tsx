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
 * Keyboard (roving tabindex, WAI-ARIA tree pattern): Up/Down move between
 * visible rows, Right expands then steps into a branch, Left collapses then
 * steps out to the parent, Enter/Space activate (select or toggle), Home/End
 * jump to the first/last visible row.
 */
import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import './TreeView.scss';

export interface TreeNode {
  readonly id: string;
  readonly label: ReactNode;
  /** Leading glyph, e.g. `<Icon name="folder" />`. */
  readonly icon?: ReactNode;
  /** Trailing detail, e.g. a count. */
  readonly detail?: ReactNode;
  /** Child nodes; presence makes this an expandable branch. */
  readonly children?: readonly TreeNode[];
  /** Defaults to true. Set false (e.g. for a root) to make the row non-selectable. */
  readonly selectable?: boolean;
}

export interface TreeViewProps {
  readonly nodes: readonly TreeNode[];
  /** Currently selected node id, or null. Controlled. */
  readonly selectedId?: string | null;
  /** Called with the node when a selectable row is activated. */
  readonly onSelect?: (node: TreeNode) => void;
  /** Ids expanded on first render. */
  readonly defaultExpandedIds?: readonly string[];
  /** Accessible name for the tree. */
  readonly ariaLabel?: string;
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
  ariaLabel,
  className,
}: TreeViewProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );
  const [focusedId, setFocusedId] = useState<string | null>(nodes[0]?.id ?? null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const visible = useMemo(() => flattenVisible(nodes, expanded), [nodes, expanded]);

  // Exactly one row is in the tab order (roving tabindex). Fall back to the
  // first visible row when the remembered one has scrolled out of existence.
  const activeId = visible.some((v) => v.node.id === focusedId)
    ? focusedId
    : (visible[0]?.node.id ?? null);

  function setBranch(id: string, open: boolean): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggle(id: string): void {
    setBranch(id, !expanded.has(id));
  }

  function focusRow(id: string): void {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function activate(node: TreeNode, hasChildren: boolean): void {
    setFocusedId(node.id);
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
      case 'Enter':
      case ' ': {
        e.preventDefault();
        activate(item.node, item.hasChildren);
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
    const isSelected = selectable && selectedId === node.id;

    return (
      <li
        key={node.id}
        role="treeitem"
        aria-expanded={hasChildren ? isOpen : undefined}
        aria-selected={selectable ? isSelected : undefined}
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
          )}
          style={{ '--sk-tree-depth': depth } as CSSProperties}
          tabIndex={node.id === activeId ? 0 : -1}
          onClick={() => activate(node, hasChildren)}
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
          <span className="sk-tree__label">{node.label}</span>
          {node.detail !== undefined && <span className="sk-tree__detail">{node.detail}</span>}
        </div>
        {hasChildren && (
          <div className={cx('sk-tree__wrap', isOpen && 'sk-tree__wrap--open')} inert={!isOpen}>
            <div className="sk-tree__inner">
              <ul className="sk-tree__group" role="group">
                {node.children!.map((child) => renderItem(child, depth + 1))}
              </ul>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <ul className={cx('sk-tree', className)} role="tree" aria-label={ariaLabel}>
      {nodes.map((node) => renderItem(node, 0))}
    </ul>
  );
}
