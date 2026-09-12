import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, CheckCircle2, FileText, Loader2, X } from 'lucide-react';
import type { AppSnapshot, PlanningChat, Task } from '../../shared/types';
import { api } from '../lib/api';
import { Markdown, MuonMark } from './common';
import { Button } from './ui/button';
import { TaskDialog } from './task-dialog';

export function PlanningChatView({ chatId, snapshot, onClose, onTaskified }: { chatId: string; snapshot: AppSnapshot; onClose: () => void; onTaskified: (task: Task) => void }) {
  const [chat, setChat] = useState<PlanningChat | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskify, setTaskify] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const load = async () => {
    try { setChat(await api<PlanningChat>(`/planning-chats/${chatId}`)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'This planning chat is no longer available.'); }
  };
  useEffect(() => { void load(); }, [chatId]);
  useEffect(() => {
    if (!chat?.busy) return;
    const timer = setInterval(() => { void load(); }, 1200);
    return () => clearInterval(timer);
  }, [chat?.busy, chatId]);
  useEffect(() => { conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' }); }, [chat?.messages.length]);
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!content.trim() || busy || chat?.busy || !chat) return;
    setBusy(true); setError(null);
    try { await api(`/planning-chats/${chatId}/messages`, 'POST', { content: content.trim() }); setContent(''); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send your message.'); }
    finally { setBusy(false); }
  }
  const firstQuestion = chat?.messages.find(message => message.role === 'user')?.content ?? '';
  const initialTitle = firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New task';
  return <div className="planning-chat-view">
    <div className="planning-chat-toolbar"><Button variant="ghost" onClick={onClose}><ArrowLeft size={15} />Back to tasks</Button><span>Disposable planning thread</span><Button variant="ghost" size="icon" aria-label="Discard planning thread" onClick={onClose}><X size={16} /></Button></div>
    <div className="planning-chat-heading"><div><span className="eyebrow">PLAN BEFORE YOU TASKIFY</span><h1>Shape the work together</h1><p>Brainstorm, ask questions, and settle the scope. This thread stays out of your task list until you make it a task.</p></div><Button onClick={() => setTaskify(true)} disabled={!chat || chat.messages.length === 0 || chat.busy}><CheckCircle2 size={15} />Taskify conversation</Button></div>
    <div ref={conversation} className="planning-chat-conversation">
      {!chat && !error && <div className="planning-chat-empty"><Loader2 size={18} className="spin" />Opening planning thread…</div>}
      {error && <div className="planning-chat-empty"><FileText size={20} /><strong>{error}</strong><Button variant="secondary" onClick={onClose}>Return to tasks</Button></div>}
      {chat && !chat.messages.length && <div className="planning-chat-empty"><div className="chief-orb"><MuonMark /></div><h2>What are you thinking about?</h2><p>Explore the problem first. I’ll help turn the conversation into a clear task when you’re ready.</p></div>}
      {chat?.messages.map(message => <article key={message.id} className={`chief-message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <MuonMark small /> : 'Y'}</div><div className="message-content"><div className="message-author">{message.role === 'assistant' ? 'Planning partner' : 'You'}{message.role === 'assistant' && <span>Claude Code · Read-only</span>}</div><Markdown>{message.content}</Markdown></div></article>)}
      {chat?.error && <p className="form-error" role="alert">{chat.error}</p>}
      {chat?.busy && <div className="chief-working"><span className="working-dots"><i /><i /><i /></span>{chat.activity ?? 'Planning partner is thinking…'}</div>}
    </div>
    <div className="planning-chat-composer-wrap">{!snapshot.runtime.providers.claude && <p className="form-notice">Claude Code is not detected. Install it, sign in, and restart the local server.</p>}{error === null && <form className="chief-composer" onSubmit={send}><label htmlFor="planning-chat-message" className="sr-only">Message your planning partner</label><textarea id="planning-chat-message" maxLength={30000} rows={2} placeholder="Ask a question or describe the idea…" value={content} onChange={event => setContent(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} /><div className="composer-bottom"><Button size="icon" aria-label="Send message" type="submit" disabled={!content.trim() || busy || chat?.busy}><ArrowUp size={17} /></Button></div></form>}</div>
    <TaskDialog key={chatId} open={taskify} onOpenChange={setTaskify} snapshot={snapshot} initialTitle={initialTitle} initialDescription="" planningChatId={chatId} onCreated={onTaskified} />
  </div>;
}
