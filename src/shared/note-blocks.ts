/** A document an agent asked Muon to publish to the Library, written as a fenced block tagged `note:<filename>`. */
export interface NoteBlock { kind: 'note'; name: string; content: string }
/** A task an agent asked Muon to create, written as a fenced block tagged `task` holding a JSON object. */
export interface TaskBlock { kind: 'task'; content: string }
export type AgentBlock = NoteBlock | TaskBlock;
export type AgentSegment = string | AgentBlock;

const OPENING = /^(`{3,}|~{3,})\s*(?:note:\s*(\S(?:.*\S)?)|task:?)\s*$/i;

/**
 * Splits agent text into plain segments and tagged blocks. A block opens with a fence whose info string is
 * `note:` plus a filename or `task`, and closes with a fence of the same character at least as long, so documents
 * that contain their own code fences use a longer outer fence. An unterminated block stays plain text.
 */
export function extractAgentBlocks(text: string): AgentSegment[] {
  const segments: AgentSegment[] = [];
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
    const content = lines.slice(index + 1, end).join('\n');
    segments.push(name ? { kind: 'note', name: name.trim(), content } : { kind: 'task', content });
    index = end + 1;
  }
  flush();
  return segments;
}

export function hasAgentBlocks(text: string): boolean {
  return extractAgentBlocks(text).some(segment => typeof segment !== 'string');
}
