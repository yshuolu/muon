import { describe, expect, it } from 'vitest';
import { extractAgentBlocks, hasAgentBlocks } from './note-blocks';

describe('agent blocks', () => {
  it('splits note and task fences from surrounding text and keeps ordinary code fences inline', () => {
    const text = 'Here are the docs.\n\n```note: folder-structure.md\n# Folder structure\n\n```ts\nexport const x = 1;\n```\n```\n\nAnd a plain snippet:\n\n```sh\npnpm install\n```\n\n~~~ note:api-discussion.md \n# API\n~~~\n```task\n{"title":"Bootstrap"}\n```\nDone.';
    expect(extractAgentBlocks(text)).toEqual([
      'Here are the docs.\n',
      { kind: 'note', name: 'folder-structure.md', content: '# Folder structure\n\n```ts\nexport const x = 1;' },
      '```\n\nAnd a plain snippet:\n\n```sh\npnpm install\n```\n',
      { kind: 'note', name: 'api-discussion.md', content: '# API' },
      { kind: 'task', content: '{"title":"Bootstrap"}' },
      'Done.',
    ]);
    expect(hasAgentBlocks(text)).toBe(true);
  });

  it('lets a longer outer fence carry inner code fences and treats unterminated blocks as text', () => {
    const nested = '````note: guide.md\n# Guide\n```ts\nconst a = 1;\n```\n````\n';
    expect(extractAgentBlocks(nested)).toEqual([{ kind: 'note', name: 'guide.md', content: '# Guide\n```ts\nconst a = 1;\n```' }, '']);
    const open = 'Start\n```note: broken.md\nnever closed';
    expect(extractAgentBlocks(open)).toEqual([open]);
    expect(hasAgentBlocks('```md\nnot a note\n```')).toBe(false);
    expect(extractAgentBlocks('```TASK:\n{}\n```')).toEqual([{ kind: 'task', content: '{}' }]);
  });
});
