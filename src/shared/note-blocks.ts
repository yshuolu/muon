/** A document an agent asked Muon to publish to the Library, written as a fenced block tagged `note:<filename>`. */
export interface NoteBlock { name: string; content: string }
export type NoteSegment = string | NoteBlock;

const OPENING = /^(`{3,}|~{3,})\s*note:\s*(\S(?:.*\S)?)\s*$/;

/**
 * Splits agent text into plain segments and note blocks. A block opens with a fence whose info string is
 * `note:` plus a filename and closes with a fence of the same character at least as long, so documents that
 * contain their own code fences use a longer outer fence. An unterminated block stays plain text.
 */
export function extractNoteBlocks(text: string): NoteSegment[] {
  const segments: NoteSegment[] = [];
  const lines = text.split('\n');
  let plain: string[] = [];
  let index = 0;
  const flush = () => { if (plain.length) { segments.push(plain.join('\n')); plain = []; } };
  while (index < lines.length) {
    const opening = OPENING.exec(lines[index]);
    if (!opening) { plain.push(lines[index]); index += 1; continue; }
    const [, fence, name] = opening;
    const closing = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end])) end += 1;
    if (end >= lines.length) { plain.push(lines[index]); index += 1; continue; }
    flush();
    segments.push({ name: name.trim(), content: lines.slice(index + 1, end).join('\n') });
    index = end + 1;
  }
  flush();
  return segments;
}

export function hasNoteBlocks(text: string): boolean {
  return extractNoteBlocks(text).some(segment => typeof segment !== 'string');
}
