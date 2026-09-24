import { describe, expect, it } from 'vitest';
import { proposedTaskFromReply } from './planning-task';

describe('proposed task extraction', () => {
  it('reads the title, description, and acceptance criteria from the closing block and drops the Taskify invitation', () => {
    const reply = `Here is how I would approach it.\n\n## Plan\n1. Add the schema.\n\n### Proposed task\n**Title:** Bootstrap the monorepo with pnpm and turbo\n**Description:** Create the initial pnpm workspace with a turbo pipeline and a TypeSpec package.\n- pnpm install succeeds from a clean checkout\n- turbo build runs the TypeSpec compiler\n\nPress Taskify when this scope looks right, or tell me what to change.`;
    expect(proposedTaskFromReply(reply)).toEqual({
      title: 'Bootstrap the monorepo with pnpm and turbo',
      description: 'Create the initial pnpm workspace with a turbo pipeline and a TypeSpec package.\n- pnpm install succeeds from a clean checkout\n- turbo build runs the TypeSpec compiler',
    });
  });

  it('tolerates plain labels, missing descriptions, and later headings', () => {
    expect(proposedTaskFromReply('Proposed task\nTitle: Ship the login page\nDescription: Build it.\n\n## Notes\nIgnore me.')).toEqual({ title: 'Ship the login page', description: 'Build it.' });
    expect(proposedTaskFromReply('### Proposed task\n**Title:** Only a title')).toEqual({ title: 'Only a title', description: '' });
  });

  it('returns nothing for replies without a proposal', () => {
    expect(proposedTaskFromReply(undefined)).toBeUndefined();
    expect(proposedTaskFromReply('Could you tell me more about the deployment target?')).toBeUndefined();
  });
});
