import { describe, expect, it } from 'vitest';
import { stripSvgRoot } from './stripSvgRoot';
import repositories from './assets/repositories.svg?raw';
import skills from './assets/skills.svg?raw';
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

const assets: Record<string, string> = {
  repositories,
  skills,
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
});
