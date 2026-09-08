import { useState } from 'react';
import { ArrowUpRight, CheckCheck, ClipboardCheck, Download, FileImage, FileText, Film, Maximize2, ShieldCheck } from 'lucide-react';
import type { Evidence, Task } from '../../shared/domain';
import { relativeTime } from '../lib/utils';
import { EmptyState, Markdown, ResultIcon } from './common';
import { Dialog } from './ui/dialog';

export function evidenceAttempts(task: Task) {
  const runs = (task.runs ?? []).filter(run => run.phase === 'verification');
  if (!runs.length) return [{ id: 'legacy', label: 'Verification', status: task.status === 'done' ? 'succeeded' : 'failed', items: task.evidence }];
  const unassigned: Evidence[] = [];
  const attempts = runs.map((run, index) => ({ id: run.id, label: `Attempt ${index + 1}`, status: run.status, startedAt: run.startedAt, items: [] as Evidence[] }));
  for (const item of task.evidence) {
    const runId = item.runId ?? runs.slice().reverse().find(run => run.startedAt <= item.createdAt)?.id;
    const attempt = attempts.find(group => group.id === runId);
    if (attempt) attempt.items.push(item); else unassigned.push(item);
  }
  return unassigned.length ? [{ id: 'legacy', label: 'Earlier evidence', status: 'succeeded', startedAt: undefined, items: unassigned }, ...attempts] : attempts;
}

export function VerificationEvidence({ task }: { task: Task }) {
  const [selectedId, setSelectedId] = useState('latest');
  const attempts = evidenceAttempts(task);
  const latest = attempts.at(-1)!;
  const selected = attempts.find(attempt => attempt.id === selectedId) ?? latest;
  const isLatest = selected.id === latest.id;
  const items = selected.items;
  if (!task.evidence.length && !(task.runs ?? []).some(run => run.phase === 'verification')) return <EmptyState icon={<ClipboardCheck size={26} />} title="Confidence comes with evidence" description="Test results, steps to reproduce, screenshots, and recordings will appear here when your agent verifies the work." />;
  return <div className="evidence-content">
    <div className="evidence-attempt-heading"><div><h3>{isLatest ? 'Latest verification' : 'Earlier verification'}</h3><p>{selected.label} · {selected.status === 'running' ? 'In progress' : selected.status === 'succeeded' ? 'Finished' : selected.status === 'canceled' ? 'Canceled' : 'Needs attention'}</p></div>{attempts.length > 1 && <label><span className="sr-only">Verification attempt</span><select value={isLatest && selectedId === 'latest' ? 'latest' : selected.id} onChange={event => setSelectedId(event.target.value)}><option value="latest">Latest attempt</option>{attempts.slice(0, -1).reverse().map(attempt => <option key={attempt.id} value={attempt.id}>{attempt.label}</option>)}</select></label>}</div>
    {!isLatest && <p className="evidence-history-note">Historical evidence is retained for review. The task’s current result comes from its latest verification.</p>}
    {isLatest && task.summary && ['done', 'blocked'].includes(task.status) && <div className="result-summary"><div className="section-label"><CheckCheck size={15} />Verification summary</div><Markdown>{task.summary}</Markdown></div>}
    {items.length ? <><div className="evidence-summary"><ShieldCheck size={16} /><strong>{items.filter(item => item.result === 'passed').length} passed</strong><span>·</span><span>{items.filter(item => item.result === 'failed').length} failed</span>{items.some(item => item.result === 'skipped') && <><span>·</span><span>{items.filter(item => item.result === 'skipped').length} skipped</span></>}<span className="evidence-artifact-count">{items.length} {items.length === 1 ? 'item' : 'items'}</span></div>{items.map(item => <EvidenceCard key={item.id} evidence={item} />)}</> : <EmptyState icon={<ClipboardCheck size={26} />} title={selected.status === 'running' ? 'Verification is in progress' : 'No evidence was captured'} description={selected.status === 'running' ? 'Results and artifacts from this attempt appear here when verification finishes.' : 'This attempt ended before producing verification evidence. Open Overview to inspect the issue and retry.'} />}
  </div>;
}

function EvidenceCard({ evidence }: { evidence: Evidence }) {
  const [expanded, setExpanded] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const Icon = evidence.kind === 'screenshot' ? FileImage : evidence.kind === 'recording' ? Film : evidence.kind === 'test' ? ClipboardCheck : FileText;
  return <article className="evidence-card"><div className="evidence-card-heading"><Icon size={17} /><h3>{evidence.title}</h3>{evidence.result && <span className={`result-badge result-${evidence.result}`}><ResultIcon result={evidence.result} />{evidence.result}</span>}</div><Markdown>{evidence.description}</Markdown>{evidence.steps && evidence.steps.length > 0 && <div className="evidence-steps"><span className="section-label">Verification steps</span><ol>{evidence.steps.map((step, index) => <li key={index}><span>{index + 1}</span>{step}</li>)}</ol></div>}
    {evidence.artifactUrl && <div className="evidence-artifact">{mediaError ? <p className="form-notice">The preview could not load. Open or download the original artifact below.</p> : evidence.kind === 'screenshot' ? <button className="evidence-image-button" onClick={() => setExpanded(true)} aria-label={`Expand ${evidence.title}`}><img src={evidence.artifactUrl} alt={evidence.title} loading="lazy" onError={() => setMediaError(true)} /><span><Maximize2 size={13} />Expand screenshot</span></button> : evidence.kind === 'recording' ? <video controls playsInline preload="metadata" src={evidence.artifactUrl} aria-label={evidence.title} onError={() => setMediaError(true)} /> : null}<div className="artifact-actions"><a href={evidence.artifactUrl} target="_blank" rel="noreferrer">Open artifact<ArrowUpRight size={13} /></a><a href={evidence.artifactUrl} download><Download size={13} />Download</a><time title={new Date(evidence.createdAt).toLocaleString()}>{relativeTime(evidence.createdAt)}</time></div></div>}
    {expanded && <Dialog open={expanded} onOpenChange={setExpanded} title={evidence.title} description="Original screenshot from this verification attempt." className="evidence-image-dialog"><img src={evidence.artifactUrl} alt={evidence.title} /><div className="artifact-actions"><a href={evidence.artifactUrl} target="_blank" rel="noreferrer">Open original<ArrowUpRight size={13} /></a><a href={evidence.artifactUrl} download><Download size={13} />Download</a></div></Dialog>}
  </article>;
}
