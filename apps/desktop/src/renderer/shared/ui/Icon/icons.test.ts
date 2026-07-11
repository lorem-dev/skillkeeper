import { describe, expect, it } from 'vitest';
import { stripSvgRoot } from './stripSvgRoot';
import { ICON_NAMES } from './Icon';
import repositories from './assets/repositories.svg?raw';
import skills from './assets/skills.svg?raw';
import skillGroup from './assets/skill-group.svg?raw';
import agent from './assets/agent.svg?raw';
import projects from './assets/projects.svg?raw';
import settings from './assets/settings.svg?raw';
import search from './assets/search.svg?raw';
import plus from './assets/plus.svg?raw';
import check from './assets/check.svg?raw';
import chevronRight from './assets/chevron-right.svg?raw';
import edit from './assets/edit.svg?raw';
import placeholder from './assets/placeholder.svg?raw';
import sync from './assets/sync.svg?raw';
import bell from './assets/bell.svg?raw';
import copy from './assets/copy.svg?raw';
import close from './assets/close.svg?raw';
import terminal from './assets/terminal.svg?raw';
import deleteIcon from './assets/delete.svg?raw';
import folder from './assets/folder.svg?raw';
import mcp from './assets/mcp.svg?raw';
import mcpGroup from './assets/mcp-group.svg?raw';
import viewTiles from './assets/view-tiles.svg?raw';
import viewTree from './assets/view-tree.svg?raw';

const assets: Record<string, string> = {
  repositories,
  skills,
  'skill-group': skillGroup,
  agent,
  projects,
  settings,
  search,
  plus,
  check,
  'chevron-right': chevronRight,
  edit,
  placeholder,
  sync,
  bell,
  copy,
  close,
  terminal,
  delete: deleteIcon,
  folder,
  mcp,
  'mcp-group': mcpGroup,
  'view-tiles': viewTiles,
  'view-tree': viewTree,
};

describe('Icon assets', () => {
  it.each(Object.entries(assets))(
    '%s is a standalone svg whose geometry strips cleanly',
    (_name, raw) => {
      expect(raw).toContain('<svg');
      expect(raw).toContain('viewBox="0 0 24 24"');
      const inner = stripSvgRoot(raw);
      expect(inner.length).toBeGreaterThan(0);
      expect(inner).not.toContain('<svg');
      expect(inner).not.toContain('</svg>');
      expect(inner).toMatch(/<(path|rect|circle)\b/);
    },
  );

  // Guards against this suite silently drifting behind a newly added
  // `IconName` (as happened for `agent`/`skill-group`): every name in the
  // `IconName` union (via `ICON_NAMES`) must have a raw-svg fixture above.
  it('covers every IconName', () => {
    expect(Object.keys(assets).sort()).toEqual([...ICON_NAMES].sort());
  });
});
