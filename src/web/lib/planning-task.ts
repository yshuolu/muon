export interface ProposedTask { title: string; description: string }

/**
 * Reads the "Proposed task" block the planning partner is asked to end with, so Taskify starts prefilled.
 * Returns undefined when the reply has no such block; the caller then falls back to the first question.
 */
export function proposedTaskFromReply(content: string | undefined): ProposedTask | undefined {
  if (!content) return undefined;
  const start = content.search(/^#{1,6}\s*proposed task\s*$/im);
  const block = start < 0 ? content : content.slice(start);
  const title = /^\s*\*{0,2}title:?\*{0,2}\s*(.+?)\s*$/im.exec(block)?.[1]?.replace(/^\*+|\*+$/g, '').trim();
  if (!title) return undefined;
  const descriptionStart = block.search(/^\s*\*{0,2}description:?\*{0,2}\s*/im);
  if (descriptionStart < 0) return { title: title.slice(0, 240), description: '' };
  const rest = block.slice(descriptionStart).replace(/^\s*\*{0,2}description:?\*{0,2}\s*/i, '');
  const end = rest.search(/^#{1,6}\s/m);
  const description = (end < 0 ? rest : rest.slice(0, end)).trim().split('\n').filter((line, index, lines) => !(index === lines.length - 1 && /taskify/i.test(line) && !/^[-*]/.test(line.trim()))).join('\n').trim();
  return { title: title.slice(0, 240), description: description.slice(0, 20_000) };
}
