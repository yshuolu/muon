import type { Task } from './types';

/** Asset links are durable references. Resolving one still requires asset authorization. */
export function assetIdFromUrl(url: string | undefined): string | undefined {
  return url ? /^asset:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})$/.exec(url)?.[1] : undefined;
}

export function assetReference(asset: { id: string; name: string }, image = false): string {
  if (!assetIdFromUrl(`asset://${asset.id}`)) throw new Error('Invalid asset ID.');
  const label = asset.name.replace(/[\\\[\]]/g, char => `\\${char}`).replace(/[\r\n]/g, ' ');
  return `${image ? '!' : ''}[${label}](asset://${asset.id})`;
}

export function assetIdsInText(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/(?<![a-zA-Z0-9_/:.-])asset:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})(?=$|[\s)\]>"'])/g), match => match[1]))];
}

/** A derived view for navigation; tasks persist references only in their text. */
export function taskAssetIds(task: Task): string[] {
  const text = [
    task.title, task.description, task.summary, task.recovery?.feedback ?? '',
    ...task.plans.flatMap(plan => [plan.content, plan.feedback ?? '']),
    ...(task.planDiscussion ?? []).map(message => message.content),
    ...(task.comments ?? []).map(message => message.content),
    ...task.evidence.flatMap(item => [item.title, item.description, ...(item.steps ?? [])]),
    ...task.activity.map(item => item.text),
  ].join('\n');
  return assetIdsInText(text);
}
