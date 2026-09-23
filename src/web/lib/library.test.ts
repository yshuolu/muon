import { describe, expect, it } from 'vitest';
import type { Asset, Task } from '../../shared/types';
import { assetReferrers, filterLibrary, libraryKind } from './library';

function asset(overrides: Partial<Asset> & Pick<Asset, 'id' | 'name'>): Asset {
  return {
    workspaceId: 'w', projectId: 'p', mediaType: 'application/octet-stream', sizeBytes: 1, sha256: 'x', storageBackendId: 'local',
    objectKey: overrides.id, origin: 'upload', createdAt: '2026-09-20T10:00:00Z', createdByUserId: 'u', ownerUserId: 'u', visibility: 'private', ...overrides,
  };
}
function task(overrides: Partial<Task> & Pick<Task, 'id' | 'identifier'>): Task {
  return { workspaceId: 'w', projectId: 'p', ownerUserId: 'u', title: 'Task', description: '', status: 'todo', phase: 'idle', priority: 0, provider: 'claude', labels: [], parentId: null, blockedByIds: [], plans: [], evidence: [], changedFiles: [], activity: [], summary: '', createdAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:00:00Z', version: 1, ...overrides };
}

const notes = asset({ id: 'notes', name: 'decisions.md', mediaType: 'text/markdown', createdAt: '2026-09-21T09:00:00Z' });
const screenshot = asset({ id: 'shot', name: 'home.png', mediaType: 'image/png', origin: 'generated', createdAt: '2026-09-22T09:00:00Z' });
const recording = asset({ id: 'clip', name: 'flow.webm', mediaType: 'video/webm', origin: 'generated', createdAt: '2026-09-19T09:00:00Z' });
const log = asset({ id: 'log', name: 'verify.log', mediaType: 'text/plain', origin: 'imported', sourcePath: 'out/verify.log' });
const archive = asset({ id: 'zip', name: 'bundle.zip', mediaType: 'application/zip', createdAt: '2026-09-20T10:00:00Z' });

describe('library kinds', () => {
  it('groups files by what the reader can show', () => {
    expect([notes, screenshot, recording, log, archive].map(libraryKind)).toEqual(['document', 'image', 'media', 'data', 'other']);
    expect(libraryKind(asset({ id: 'audio', name: 'call.mp3', mediaType: 'audio/mpeg' }))).toBe('media');
    expect(libraryKind(asset({ id: 'svg', name: 'logo.svg', mediaType: 'image/svg+xml' }))).toBe('data');
  });
});

describe('library filtering', () => {
  const all = [log, notes, archive, screenshot, recording];
  it('sorts newest first and breaks ties deterministically', () => {
    expect(filterLibrary(all, { query: '', kind: 'all', origin: 'all' }).map(item => item.id)).toEqual(['shot', 'notes', 'zip', 'log', 'clip']);
  });
  it('combines kind, origin, and search filters', () => {
    expect(filterLibrary(all, { query: '', kind: 'media', origin: 'all' }).map(item => item.id)).toEqual(['clip']);
    expect(filterLibrary(all, { query: '', kind: 'all', origin: 'generated' }).map(item => item.id)).toEqual(['shot', 'clip']);
    expect(filterLibrary(all, { query: 'VERIFY', kind: 'data', origin: 'imported' }).map(item => item.id)).toEqual(['log']);
    expect(filterLibrary(all, { query: 'verify', kind: 'document', origin: 'all' })).toEqual([]);
  });
  it('matches the source path and the tasks that reference a file', () => {
    const referrers = assetReferrers([task({ id: 't1', identifier: 'MUO-7', title: 'Ship the homepage', summary: `![Home](asset://shot)` })]);
    expect(filterLibrary(all, { query: 'out/', kind: 'all', origin: 'all' }).map(item => item.id)).toEqual(['log']);
    expect(filterLibrary(all, { query: 'muo-7', kind: 'all', origin: 'all' }, referrers).map(item => item.id)).toEqual(['shot']);
    expect(filterLibrary(all, { query: 'homepage', kind: 'all', origin: 'all' }, referrers).map(item => item.id)).toEqual(['shot']);
    expect(filterLibrary(all, { query: 'homepage', kind: 'all', origin: 'all' })).toEqual([]);
  });
});

describe('asset referrers', () => {
  it('collects every task that references an asset anywhere in its text', () => {
    const referrers = assetReferrers([
      task({ id: 't1', identifier: 'MUO-1', description: '[Notes](asset://notes)' }),
      task({ id: 't2', identifier: 'MUO-2', plans: [{ id: 'plan', version: 1, format: 'markdown', content: 'See asset://notes and ![Shot](asset://shot)', status: 'pending', createdAt: '2026-09-08T10:00:00Z' }] }),
      task({ id: 't3', identifier: 'MUO-3', comments: [{ id: 'c', role: 'assistant', content: 'Same file: asset://notes', createdAt: '2026-09-08T10:00:00Z' }] }),
    ]);
    expect(referrers.get('notes')?.map(item => item.identifier)).toEqual(['MUO-1', 'MUO-2', 'MUO-3']);
    expect(referrers.get('shot')?.map(item => item.identifier)).toEqual(['MUO-2']);
    expect(referrers.get('missing')).toBeUndefined();
  });
});
