import { describe, it, expect } from 'vitest';
import {
  guidanceKey,
  skillGuidanceId,
  upsertGuidanceBlock,
  removeGuidanceBlock,
  hasGuidanceBlock,
} from './guidance.js';

const REMOTE = 'git@github.com:acme/skills.git';
const KEY = guidanceKey(REMOTE, 'web/api');

describe('skillGuidanceId', () => {
  it('joins group and name, or uses name alone', () => {
    expect(skillGuidanceId('web', 'api')).toBe('web/api');
    expect(skillGuidanceId(undefined, 'api')).toBe('api');
  });
});

describe('upsertGuidanceBlock', () => {
  it('appends a delimited block to empty content with a trailing newline', () => {
    const out = upsertGuidanceBlock('', KEY, 'Body line.');
    expect(out).toBe(
      `<!-- SKILLKEEPER_START: ${KEY} -->\nBody line.\n<!-- SKILLKEEPER_END: ${KEY} -->\n`,
    );
  });

  it('appends after existing content, separated by a blank line', () => {
    const out = upsertGuidanceBlock('# Project\n\nHello.\n', KEY, 'Body.');
    expect(out).toBe(
      `# Project\n\nHello.\n\n<!-- SKILLKEEPER_START: ${KEY} -->\nBody.\n<!-- SKILLKEEPER_END: ${KEY} -->\n`,
    );
  });

  it('replaces an existing block in place, preserving surrounding content and position', () => {
    const before =
      `top\n\n<!-- SKILLKEEPER_START: ${KEY} -->\nOLD\n<!-- SKILLKEEPER_END: ${KEY} -->\n\nbottom\n`;
    const out = upsertGuidanceBlock(before, KEY, 'NEW');
    expect(out).toBe(
      `top\n\n<!-- SKILLKEEPER_START: ${KEY} -->\nNEW\n<!-- SKILLKEEPER_END: ${KEY} -->\n\nbottom\n`,
    );
  });

  it('does not touch a different skill block', () => {
    const otherKey = guidanceKey(REMOTE, 'other');
    const withOther =
      `<!-- SKILLKEEPER_START: ${otherKey} -->\nX\n<!-- SKILLKEEPER_END: ${otherKey} -->\n`;
    const out = upsertGuidanceBlock(withOther, KEY, 'Body.');
    expect(out).toContain(`SKILLKEEPER_START: ${otherKey}`);
    expect(out).toContain(`SKILLKEEPER_START: ${KEY}`);
  });
});

describe('removeGuidanceBlock', () => {
  it('removes the block and the blank line before it', () => {
    const before =
      `# Project\n\nHello.\n\n<!-- SKILLKEEPER_START: ${KEY} -->\nBody.\n<!-- SKILLKEEPER_END: ${KEY} -->\n`;
    expect(removeGuidanceBlock(before, KEY)).toBe('# Project\n\nHello.\n');
  });

  it('returns the input unchanged when the block is absent', () => {
    expect(removeGuidanceBlock('# Project\n', KEY)).toBe('# Project\n');
  });

  it('removes the only block, leaving empty content', () => {
    const only = `<!-- SKILLKEEPER_START: ${KEY} -->\nBody.\n<!-- SKILLKEEPER_END: ${KEY} -->\n`;
    expect(removeGuidanceBlock(only, KEY)).toBe('');
  });
});

describe('hasGuidanceBlock', () => {
  it('detects presence', () => {
    const out = upsertGuidanceBlock('', KEY, 'Body.');
    expect(hasGuidanceBlock(out, KEY)).toBe(true);
    expect(hasGuidanceBlock('', KEY)).toBe(false);
  });
});
