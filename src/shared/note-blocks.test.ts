import { describe, expect, it } from 'vitest';
import { extractNoteBlocks, hasNoteBlocks } from './note-blocks';

describe('note blocks', () => {
  it('splits tagged fences from surrounding text and keeps ordinary code fences inline', () => {
    const text = 'Here are the docs.\n\n```note: folder-structure.md\n# Folder structure\n\n```ts\nexport const x = 1;\n```\n```\n\nAnd a plain snippet:\n\n```sh\npnpm install\n```\n\n~~~ note:api-discussion.md \n# API\n~~~\nDone.';
    expect(extractNoteBlocks(text)).toEqual([
      'Here are the docs.\n',
      { name: 'folder-structure.md', content: '# Folder structure\n\n```ts\nexport const x = 1;' },
      '```\n\nAnd a plain snippet:\n\n```sh\npnpm install\n```\n',
      { name: 'api-discussion.md', content: '# API' },
      'Done.',
    ]);
    expect(hasNoteBlocks(text)).toBe(true);
  });

  it('lets a longer outer fence carry inner code fences and treats unterminated blocks as text', () => {
    const nested = '````note: guide.md\n# Guide\n```ts\nconst a = 1;\n```\n````\n';
    expect(extractNoteBlocks(nested)).toEqual([{ name: 'guide.md', content: '# Guide\n```ts\nconst a = 1;\n```' }, '']);
    const open = 'Start\n```note: broken.md\nnever closed';
    expect(extractNoteBlocks(open)).toEqual([open]);
    expect(hasNoteBlocks('```md\nnot a note\n```')).toBe(false);
  });
});
