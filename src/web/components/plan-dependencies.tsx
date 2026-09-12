import { ArrowUpRight, ChevronRight, Download, GitBranch } from 'lucide-react';
import type { Plan, Task } from '../../shared/types';
import { FileChanges, Markdown } from './common';

export function PlanDependencies({ plan, tasks, onSelect }: { plan: Plan; tasks: Task[]; onSelect: (task: Task) => void }) {
  const changeInputs = plan.dependencyInputs ?? [];
  const resultInputs = plan.resultInputs ?? [];
  if (!changeInputs.length && !resultInputs.length) return null;
  return <details className="plan-dependencies"><summary><ChevronRight size={12} className="dependency-expand" /><GitBranch size={14} />Dependency inputs included in this RFC<span>{changeInputs.length + resultInputs.length}</span></summary><p>These snapshots were captured when this RFC was written. Your approval applies to these exact inputs.</p>{changeInputs.map(input => {
    const task = tasks.find(task => task.id === input.taskId);
    return <article key={input.taskId}><div className="plan-dependency-heading"><strong>{input.identifier}</strong><span>{input.title}</span>{task && <button onClick={() => onSelect(task)} aria-label={`Open ${input.identifier}`}><ArrowUpRight size={13} /></button>}</div><div className="plan-dependency-meta"><span>{input.changes.files.length} changed {input.changes.files.length === 1 ? 'file' : 'files'}</span><time>{new Date(input.capturedAt).toLocaleString()}</time><code title={input.changes.sha256}>SHA {input.changes.sha256.slice(0, 12)}</code></div><div className="plan-dependency-files">{input.changes.files.map(file => <div key={file.path}><code>{file.path}</code><FileChanges additions={file.additions} deletions={file.deletions} /></div>)}</div><button className="patch-download" onClick={() => {
      const changes = input.changes;
      const bytes = changes.patchEncoding === 'base64' ? Uint8Array.from(atob(changes.patch), character => character.charCodeAt(0)) : new TextEncoder().encode(changes.patch);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/x-patch' }));
      const link = document.createElement('a'); link.href = url; link.download = `${input.identifier}-${changes.sha256.slice(0, 12)}.patch`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}><Download size={13} />Download reviewed patch</button></article>;
  })}{resultInputs.map(input => {
    const task = tasks.find(task => task.id === input.taskId);
    return <article key={`result:${input.taskId}`}><div className="plan-dependency-heading"><strong>{input.identifier}</strong><span>Saved outcome</span>{task && <button onClick={() => onSelect(task)} aria-label={`Open ${input.identifier}`}><ArrowUpRight size={13} /></button>}</div><div className="plan-dependency-meta"><time>{new Date(input.capturedAt).toLocaleString()}</time><code title={input.sha256}>SHA {input.sha256.slice(0, 12)}</code></div>{input.outputs.length ? input.outputs.map(output => <div key={output.id}><span className="section-label">{output.kind === 'ideas' ? 'Ideas' : 'Research findings'}</span><Markdown>{output.content}</Markdown></div>) : <Markdown>{input.summary}</Markdown>}</article>;
  })}</details>;
}
