import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, CheckCircle2, FileText, Loader2, X } from 'lucide-react';
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
  const [sendError, setSendError] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const modelSelect = useRef<HTMLSelectElement>(null);
  const chatConfig = snapshot.runtime.config?.claude ?? { model: 'claude-fable-5-1[1m]', thinking: 'max' };
  const model = chat?.model ?? chatConfig.model;
  const modelOptions = [...new Set([chatConfig.model, model, 'opus', 'sonnet', 'haiku'])];
  const modelDisabled = !chat || busy || savingModel || chat.busy;
  const conversation = useRef<HTMLDivElement>(null);
  const chatMutationVersion = useRef(0);
  const chatLoadVersion = useRef(0);
  const appliedChatLoadVersion = useRef(0);
  const load = async () => {
    const mutationVersion = chatMutationVersion.current;
    const loadVersion = ++chatLoadVersion.current;
    try {
      const loaded = await api<PlanningChat>(`/planning-chats/${chatId}`);
      if (mutationVersion !== chatMutationVersion.current || loadVersion < appliedChatLoadVersion.current) return;
      appliedChatLoadVersion.current = loadVersion;
      setChat(loaded); setError(null);
    } catch (cause) {
      if (mutationVersion !== chatMutationVersion.current || loadVersion < appliedChatLoadVersion.current) return;
      appliedChatLoadVersion.current = loadVersion;
      setError(cause instanceof Error ? cause.message : 'This planning chat is no longer available.');
    }
  };
  useEffect(() => { void load(); }, [chatId]);
  useEffect(() => {
    if (!chat?.busy) return;
    const timer = setInterval(() => { void load(); }, 1200);
    return () => clearInterval(timer);
  }, [chat?.busy, chatId]);
  useEffect(() => { conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' }); }, [chat?.messages.length]);
  function closeModelEdit() {
    setCustomModel(false);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) modelSelect.current?.focus();
    });
  }
  async function saveModel(nextModel: string) {
    if (modelDisabled) return;
    ++chatMutationVersion.current;
    setSavingModel(true);
    setModelError(null);
    try {
      const saved = await api<PlanningChat>(`/planning-chats/${chatId}`, 'PATCH', { model: nextModel === chatConfig.model ? null : nextModel });
      // Older polls must not replace the model confirmed by this save.
      ++chatMutationVersion.current;
      setChat(saved);
      closeModelEdit();
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : 'Could not save the planning chat model.');
    } finally {
      setSavingModel(false);
    }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!content.trim() || modelDisabled || customModel) return;
    ++chatMutationVersion.current;
    setBusy(true); setSendError(null);
    try { await api(`/planning-chats/${chatId}/messages`, 'POST', { content: content.trim() }); setContent(''); await load(); }
    catch (cause) { setSendError(cause instanceof Error ? cause.message : 'Could not send your message.'); }
    finally { setBusy(false); }
  }
  const firstQuestion = chat?.messages.find(message => message.role === 'user')?.content ?? '';
  const initialTitle = firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New task';
  return <div className="planning-chat-view">
    <div className="planning-chat-toolbar"><Button variant="ghost" onClick={onClose}><ArrowLeft size={15} />Back to tasks</Button><span>Disposable planning thread</span><Button variant="ghost" size="icon" aria-label="Discard planning thread" onClick={onClose}><X size={16} /></Button></div>
    <div className="planning-chat-heading"><div><span className="eyebrow">PLAN BEFORE YOU TASKIFY</span><h1>Shape the work together</h1><p>Brainstorm, ask questions, and settle the scope. This thread stays out of your task list until you make it a task.</p></div><Button onClick={() => setTaskify(true)} disabled={modelDisabled || !chat?.messages.length}><CheckCircle2 size={15} />Taskify conversation</Button></div>
    <div ref={conversation} className="planning-chat-conversation">
      {!chat && !error && <div className="planning-chat-empty"><Loader2 size={18} className="spin" />Opening planning thread…</div>}
      {error && <div className="planning-chat-empty"><FileText size={20} /><strong>{error}</strong><Button variant="secondary" onClick={onClose}>Return to tasks</Button></div>}
      {chat && !chat.messages.length && <div className="planning-chat-empty"><div className="chief-orb"><MuonMark /></div><h2>What are you thinking about?</h2><p>Explore the problem first. I’ll help turn the conversation into a clear task when you’re ready.</p></div>}
      {chat?.messages.map(message => <article key={message.id} className={`chief-message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <MuonMark small /> : 'Y'}</div><div className="message-content"><div className="message-author">{message.role === 'assistant' ? 'Planning partner' : 'You'}{message.role === 'assistant' && <span>Claude Code · Read-only</span>}</div><Markdown>{message.content}</Markdown></div></article>)}
      {chat?.error && <p className="form-error" role="alert">{chat.error}</p>}
      {chat?.busy && <div className="chief-working"><span className="working-dots"><i /><i /><i /></span>{chat.activity ?? 'Planning partner is thinking…'}</div>}
    </div>
    <div className="planning-chat-composer-wrap">
      {!snapshot.runtime.providers.claude && <p className="form-notice">Claude Code is not detected. Install it, sign in, and restart the local server.</p>}
      {sendError && <p className="form-error" role="alert">{sendError}</p>}
      {error === null && <form className="chief-composer" onSubmit={send}>
        <label htmlFor="planning-chat-message" className="sr-only">Message your planning partner</label>
        <textarea id="planning-chat-message" maxLength={30000} rows={2} placeholder="Ask a question or describe the idea…" value={content} onChange={event => setContent(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} />
        <div className="composer-bottom chief-composer-bottom">
          <div className="chief-runtime-meta">
            <span><span className="provider-symbol" aria-hidden="true">✳</span>Claude Code</span>
            {customModel ? <div className="chief-model-editor">
              <input aria-label="Custom planning chat model" aria-describedby={modelError ? 'planning-chat-model-error' : undefined} value={modelDraft} onChange={event => setModelDraft(event.target.value)} maxLength={200} autoComplete="off" autoFocus spellCheck={false} disabled={modelDisabled} onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') { event.preventDefault(); if (modelDraft.trim()) void saveModel(modelDraft.trim()); }
                else if (event.key === 'Escape' && !savingModel) { event.preventDefault(); event.stopPropagation(); setModelError(null); closeModelEdit(); }
              }} />
              <button type="button" aria-label="Save model" title="Save model" disabled={modelDisabled || !modelDraft.trim()} onClick={() => void saveModel(modelDraft.trim())}><Check size={14} /></button>
              <button type="button" aria-label="Cancel model edit" title="Cancel" disabled={savingModel} onClick={() => { setModelError(null); closeModelEdit(); }}><X size={14} /></button>
            </div> : <select ref={modelSelect} className="chief-model-control" aria-label="Planning chat model" aria-describedby={modelError ? 'planning-chat-model-error' : undefined} title={model} value={model} disabled={modelDisabled} style={{ width: `${Math.min(model.length + 5, 38)}ch` }} onChange={event => {
              const nextModel = event.target.value;
              if (!nextModel) { setModelDraft(model); setModelError(null); setCustomModel(true); }
              else { void saveModel(nextModel); }
            }}>
              {modelOptions.map(option => <option key={option} value={option}>{option}{option === chatConfig.model ? ' (default)' : ''}</option>)}
              <option value="">Enter model ID…</option>
            </select>}
            <span>Thinking: {chatConfig.thinking}</span>
          </div>
          <Button size="icon" aria-label="Send message" type="submit" disabled={!content.trim() || modelDisabled || customModel}><ArrowUp size={17} /></Button>
        </div>
        {modelError && <p id="planning-chat-model-error" className="form-error chief-model-error" role="alert">{modelError}</p>}
        {savingModel && <span className="sr-only" role="status">Saving model…</span>}
      </form>}
    </div>
    <TaskDialog key={chatId} open={taskify} onOpenChange={setTaskify} snapshot={snapshot} initialTitle={initialTitle} initialDescription="" planningChatId={chatId} onCreated={onTaskified} />
  </div>;
}
