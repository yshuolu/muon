import { describe, expect, it } from 'vitest';
import type { Asset } from '../../shared/types';
import { filterMentions, insertMention, mentionQuery } from './mentions';

const doc = (id: string, name: string, createdAt: string, latestVersionId?: string): Asset => ({
  id, name, createdAt, latestVersionId, workspaceId: 'w', projectId: 'p', mediaType: 'text/markdown', sizeBytes: 10, sha256: 'x', storageBackendId: 'local', objectKey: id,
  origin: 'upload', createdByUserId: 'u', ownerUserId: 'u', visibility: 'private',
});

describe('mentions', () => {
  it('detects an @ query at the caret but not inside words or e-mail addresses', () => {
    expect(mentionQuery('see @api', 8)).toEqual({ start: 4, query: 'api' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('(@spec', 6)).toEqual({ start: 1, query: 'spec' });
    expect(mentionQuery('mail me@example.com', 19)).toBeNull();
    expect(mentionQuery('see @api done', 8)).toEqual({ start: 4, query: 'api' });
    expect(mentionQuery('see @api done', 13)).toBeNull();
  });

  it('lists current document versions with prefix matches first, then newest', () => {
    const assets = [
      doc('old', 'api-discussion.md', '2026-09-01T00:00:00Z', 'new'),
      doc('new', 'api-discussion.md', '2026-09-02T00:00:00Z'),
      doc('folders', 'folder-structure.md', '2026-09-03T00:00:00Z'),
      doc('notes', 'notes-on-api.md', '2026-09-04T00:00:00Z'),
    ];
    expect(filterMentions(assets, 'api').map(asset => asset.id)).toEqual(['new', 'notes']);
    expect(filterMentions(assets, '').map(asset => asset.id)).toEqual(['notes', 'folders', 'new']);
    expect(filterMentions(assets, 'zzz')).toEqual([]);
  });

  it('replaces the typed query with a Markdown asset reference', () => {
    const mention = mentionQuery('Compare @api with the spec', 12)!;
    expect(insertMention('Compare @api with the spec', mention, 12, { id: 'abc', name: 'api-discussion.md' })).toEqual({
      text: 'Compare [api-discussion.md](asset://abc)  with the spec', caret: 41,
    });
  });
});
