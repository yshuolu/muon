import { describe, expect, it } from 'vitest';
import type { AssetComment } from '../../shared/types';
import { anchorFromSelection, collapse, locateAnchor, rehypeCommentMarks, sortComments } from './document-comments';

const comment = (id: string, anchor: AssetComment['anchor'], status: AssetComment['status'] = 'pending', createdAt = '2026-09-24T10:00:00Z'): AssetComment =>
  ({ id, assetId: 'doc', requestId: id, content: 'note', anchor, createdAt, updatedAt: createdAt, status });

describe('anchors', () => {
  it('collapses whitespace and picks the occurrence whose context matches best, then the nearest one', () => {
    const text = collapse('Alpha beta gamma.\n\nBeta again here. Beta again there.');
    expect(locateAnchor(text, { quote: 'Beta again', prefix: 'here. ', suffix: ' there', start: 0 })).toEqual({ start: 35, end: 45 });
    expect(locateAnchor(text, { quote: 'Beta again', prefix: '', suffix: '', start: 40 })).toEqual({ start: 35, end: 45 });
    expect(locateAnchor(text, { quote: 'Beta  again', prefix: '', suffix: '', start: 0 })).toEqual({ start: 18, end: 28 });
    expect(locateAnchor(text, { quote: 'missing', prefix: '', suffix: '', start: 0 })).toBeUndefined();
  });

  it('builds an anchor from the text around a selection', () => {
    expect(anchorFromSelection('Intro paragraph.\n\nThe ', 'quick   brown', ' fox jumps.')).toEqual({ quote: 'quick brown', prefix: 'Intro paragraph. The ', suffix: ' fox jumps.', start: 21 });
    expect(anchorFromSelection('x', '   ', 'y')).toBeUndefined();
  });

  it('orders comments by position with whole-document comments last', () => {
    const text = 'One two three four';
    const sorted = sortComments([
      comment('whole', undefined, 'pending', '2026-09-24T09:00:00Z'),
      comment('late', { quote: 'four', prefix: '', suffix: '', start: 0 }),
      comment('early', { quote: 'two', prefix: '', suffix: '', start: 0 }),
      comment('gone', { quote: 'five', prefix: '', suffix: '', start: 0 }),
    ], text);
    expect(sorted.map(item => item.id)).toEqual(['early', 'late', 'gone', 'whole']);
  });
});

describe('comment marks', () => {
  it('wraps matched text across inline boundaries and blocks without disturbing other text', () => {
    const tree = { type: 'root', children: [
      { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'Keep ' }, { type: 'element', tagName: 'strong', properties: {}, children: [{ type: 'text', value: 'this bold' }] }, { type: 'text', value: ' and more.' }] },
      { type: 'text', value: '\n' },
      { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'Second paragraph.' }] },
    ] };
    rehypeCommentMarks({ comments: [
      comment('a', { quote: 'bold and', prefix: 'this ', suffix: ' more', start: 0 }),
      comment('b', { quote: 'Second', prefix: '', suffix: '', start: 0 }, 'resolved'),
      comment('c', { quote: 'nowhere', prefix: '', suffix: '', start: 0 }),
    ] })(tree);
    const first = tree.children[0] as { children: Array<{ type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Array<{ type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Array<{ value?: string }> }> }> };
    expect(first.children[0]).toEqual({ type: 'text', value: 'Keep ' });
    const strong = first.children[1];
    expect(strong.children?.map(child => [child.type, child.tagName, child.value ?? child.children?.[0].value])).toEqual([['text', undefined, 'this '], ['element', 'mark', 'bold']]);
    expect(strong.children?.[1].properties).toEqual({ className: ['doc-comment', 'pending'], dataCommentId: 'a', dataCommentIds: 'a' });
    expect(first.children.slice(2).map(child => [child.tagName ?? child.type, child.value ?? child.children?.[0].value])).toEqual([['mark', ' and'], ['text', ' more.']]);
    const second = tree.children[2] as { children: Array<{ tagName?: string; type: string; value?: string; properties?: Record<string, unknown>; children?: Array<{ value?: string }> }> };
    expect(second.children.map(child => [child.tagName ?? child.type, child.value ?? child.children?.[0].value])).toEqual([['mark', 'Second'], ['text', ' paragraph.']]);
    expect(second.children[0].properties?.className).toEqual(['doc-comment', 'resolved']);
  });

  it('leaves the tree alone when nothing is anchored', () => {
    const tree = { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'Plain' }] }] };
    rehypeCommentMarks({ comments: [comment('whole', undefined)] })(tree);
    expect(tree.children[0].children).toEqual([{ type: 'text', value: 'Plain' }]);
  });
});
