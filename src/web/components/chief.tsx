import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, CheckCircle2, ListTodo, Sparkles } from 'lucide-react';
import type { AppSnapshot, Task } from '../../shared/types';
import { api } from '../lib/api';
import { Markdown, MuonMark } from './common';
import { Button } from './ui/button';

export function ChiefView({ snapshot, onRefresh, onSelect }: { snapshot: AppSnapshot; onRefresh: () => void; onSelect: (task: Task) => void }) {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chiefQueued = snapshot.runtime.chiefRunning && snapshot.runtime.activeRuns >= snapshot.settings.maxConcurrentAgents && snapshot.tasks.filter(task => task.runId && task.status === 'in_progress').length >= snapshot.runtime.activeRuns;
  const chiefConfig = snapshot.runtime.config?.claude ?? { model: 'claude-fable-5-1[1m]', thinking: 'max', bypassPermissions: true };
  const conversation = useRef<HTMLDivElement>(null);
  useEffect(() => { conversation.current?.scrollTo({ top: 0, behavior: 'smooth' }); }, [snapshot.messages.length]);
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!content.trim() || busy || snapshot.runtime.chiefRunning) return;
    setBusy(true); setError(null);
    try { await api('/chief/messages', 'POST', { content: content.trim() }); setContent(''); onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach your chief of staff.'); }
    finally { setBusy(false); }
  }
  return <div className="chief-view"><div ref={conversation} className="chief-conversation">
    {snapshot.messages.length === 0 ? <div className="chief-welcome"><div className="chief-orb"><MuonMark /></div><span className="eyebrow">YOUR CHIEF OF STAFF</span><h2>Big picture. Next steps.</h2><p>A thinking partner who knows your tasks.<br />Tell me what’s on your mind. We’ll turn it into progress.</p><div className="chief-suggestions">{[
      { icon: ListTodo, title: 'Make a plan', text: 'Help me break down my next feature into clear, actionable tasks.' },
      { icon: CheckCircle2, title: 'Find my focus', text: 'Review my tasks and tell me what needs my attention first.' },
      { icon: Sparkles, title: 'See the big picture', text: 'Give me a concise update on this project and what is ready to ship.' },
    ].map(suggestion => <button key={suggestion.title} onClick={() => setContent(suggestion.text)}><suggestion.icon size={17} /><span>{suggestion.title}</span><ArrowRight size={14} /></button>)}</div></div> : <div className="chief-messages">{snapshot.messages.map(message => <article key={message.id} className={`chief-message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <MuonMark small /> : 'Y'}</div><div className="message-content"><div className="message-author">{message.role === 'assistant' ? 'Chief of staff' : 'You'}{message.role === 'assistant' && <span>Claude Code</span>}</div><Markdown>{message.content}</Markdown>{Boolean(message.taskIds?.length) && <div className="message-task-links">{message.taskIds?.map(id => { const task = snapshot.tasks.find(t => t.id === id); return task ? <button key={id} onClick={() => onSelect(task)}><span>{task.identifier}</span>{task.title}<ArrowRight size={13} /></button> : null; })}</div>}</div></article>)}</div>}
    {(snapshot.runtime.chiefRunning || busy) && <div className="chief-working"><span className="working-dots"><i /><i /><i /></span>{chiefQueued ? 'Request saved. Waiting for an available agent slot…' : snapshot.runtime.chiefActivity ?? 'Chief of staff is working on it…'}</div>}
    </div><div className="chief-composer-wrap">{!snapshot.runtime.providers.claude && <p className="form-notice chief-runtime-notice">Claude Code is not detected. Install it, sign in, and restart the local server to use your chief of staff.</p>}{error && <p className="form-error" role="alert">{error}</p>}<div className="chief-runtime-meta"><span><span className="provider-symbol">✳</span>Chief of staff · Claude Code · <code>{chiefConfig.model}</code> · Thinking: {chiefConfig.thinking} · Scoped controls</span></div><form className="chief-composer" onSubmit={send}><label htmlFor="chief-message" className="sr-only">Message your chief of staff</label><textarea id="chief-message" maxLength={30000} rows={2} placeholder="What should we work on?" value={content} onChange={e => setContent(e.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} /><div className="composer-bottom"><Button size="icon" aria-label="Send message" type="submit" disabled={!content.trim() || busy || snapshot.runtime.chiefRunning}><ArrowUp size={17} /></Button></div></form><p className="composer-hint">Plans and results, without the noise.<span>Enter to send · Shift + Enter for a new line</span></p></div></div>;
}
