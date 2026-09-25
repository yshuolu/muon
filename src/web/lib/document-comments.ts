import type { AssetComment, AssetCommentAnchor } from '../../shared/types';

/** Whitespace-insensitive text: every run of whitespace becomes one space so rendered and source text compare equal. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

export interface AnchorRange { start: number; end: number }

/**
 * Finds the quoted passage in collapsed text. Every occurrence is scored by how much of the stored prefix and
 * suffix agree with its surroundings; ties go to the occurrence nearest the remembered offset.
 */
export function locateAnchor(text: string, anchor: AssetCommentAnchor): AnchorRange | undefined {
  const quote = collapse(anchor.quote).trim();
  if (!quote) return undefined;
  const prefix = collapse(anchor.prefix);
  const suffix = collapse(anchor.suffix);
  let best: { range: AnchorRange; score: number; distance: number } | undefined;
  for (let index = text.indexOf(quote); index >= 0; index = text.indexOf(quote, index + 1)) {
    const before = text.slice(Math.max(0, index - prefix.length), index);
    const after = text.slice(index + quote.length, index + quote.length + suffix.length);
    let score = 0;
    for (let offset = 1; offset <= Math.min(before.length, prefix.length) && before[before.length - offset] === prefix[prefix.length - offset]; offset += 1) score += 1;
    for (let offset = 0; offset < Math.min(after.length, suffix.length) && after[offset] === suffix[offset]; offset += 1) score += 1;
    const distance = Math.abs(index - anchor.start);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { range: { start: index, end: index + quote.length }, score, distance };
  }
  return best?.range;
}

/** Comments in reading order: anchored ones by position in the collapsed text, whole-document comments last. */
export function sortComments(comments: AssetComment[], text: string): AssetComment[] {
  const positions = new Map(comments.map(comment => [comment.id, comment.anchor ? locateAnchor(text, comment.anchor)?.start ?? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER]));
  return [...comments].sort((a, b) => positions.get(a.id)! - positions.get(b.id)! || a.createdAt.localeCompare(b.createdAt));
}

interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
interface TextSlot { parent: HastNode; index: number; node: HastNode; start: number }

/** Builds an anchor from a selection inside a rendered document, given the text before and after it. */
export function anchorFromSelection(before: string, selected: string, after: string): AssetCommentAnchor | undefined {
  const quote = collapse(selected).trim();
  if (!quote) return undefined;
  const collapsedBefore = collapse(before);
  return { quote, prefix: collapsedBefore.slice(-32), suffix: collapse(after).slice(0, 32), start: collapsedBefore.length };
}

/**
 * A rehype plugin that wraps the text of each anchored comment in `<mark>` elements. It works on the hast tree's
 * own text, splitting text nodes at range boundaries, so bold, links, code, and multi-block selections all
 * highlight, and the marks survive re-renders because they are part of the rendered tree.
 */
export function rehypeCommentMarks({ comments }: { comments: Array<Pick<AssetComment, 'id' | 'status' | 'anchor'>> }) {
  return (tree: HastNode) => {
    const anchored = comments.filter(comment => comment.anchor);
    if (!anchored.length) return;
    const slots: TextSlot[] = [];
    let raw = '';
    const visit = (node: HastNode) => {
      node.children?.forEach((child, index) => {
        if (child.type === 'text') { slots.push({ parent: node, index, node: child, start: raw.length }); raw += child.value ?? ''; }
        else visit(child);
      });
    };
    visit(tree);
    // Collapse whitespace for matching while remembering where each collapsed character came from.
    const rawIndex: number[] = [];
    let collapsed = '';
    for (let position = 0; position < raw.length; position += 1) {
      const character = raw[position];
      if (/\s/.test(character)) {
        if (collapsed.endsWith(' ')) continue;
        collapsed += ' ';
      } else collapsed += character;
      rawIndex.push(position);
    }
    const ranges = anchored.flatMap(comment => {
      const range = locateAnchor(collapsed, comment.anchor!);
      return range ? [{ id: comment.id, status: comment.status, start: rawIndex[range.start], end: rawIndex[range.end - 1] + 1 }] : [];
    });
    if (!ranges.length) return;
    // Replace from the last slot backwards so earlier child indexes stay valid.
    for (const slot of [...slots].reverse()) {
      const value = slot.node.value ?? '';
      const end = slot.start + value.length;
      const covering = ranges.filter(range => range.start < end && range.end > slot.start);
      if (!covering.length) continue;
      const boundaries = [...new Set([slot.start, end, ...covering.flatMap(range => [Math.max(range.start, slot.start), Math.min(range.end, end)])])].sort((a, b) => a - b);
      const pieces: HastNode[] = [];
      for (let piece = 0; piece < boundaries.length - 1; piece += 1) {
        const [from, to] = [boundaries[piece], boundaries[piece + 1]];
        if (from === to) continue;
        const text: HastNode = { type: 'text', value: value.slice(from - slot.start, to - slot.start) };
        const owners = covering.filter(range => range.start <= from && range.end >= to);
        pieces.push(owners.length
          ? { type: 'element', tagName: 'mark', properties: { className: ['doc-comment', owners.some(owner => owner.status === 'pending') ? 'pending' : 'resolved'], dataCommentId: owners[0].id, dataCommentIds: owners.map(owner => owner.id).join(' ') }, children: [text] }
          : text);
      }
      slot.parent.children!.splice(slot.index, 1, ...pieces);
    }
  };
}
