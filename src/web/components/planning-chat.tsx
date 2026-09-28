import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ArrowUp, Check, CheckCircle2, FileText, History, Loader2, Trash2, X } from 'lucide-react';
import type { AppSnapshot, PlanningChat, PlanningChatMessage, PlanningChatSummary, Provider, Task } from '../../shared/types';
import { ApiError } from '../../shared/api-client';
import { api } from '../lib/api';
import { useConversationScroll } from '../lib/conversation-scroll';
import { deliverNotification } from '../lib/notifications';
import { proposedTaskFromReply } from '../lib/planning-task';
import { relativeTime } from '../lib/utils';
import { Markdown, MuonMark } from './common';
import { ConversationUnreadBoundary, ConversationViewport } from './conversation-viewport';
import { Button } from './ui/button';
import { EffortSelect } from './effort-select';
import { MentionTextarea } from './mention-textarea';
import { TaskDialog } from './task-dialog';

const PROVIDER_LABELS: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };
const PROVIDER_SYMBOLS: Record<Provider, string> = { claude: '✳', codex: '⌘' };
const FALLBACK_CONFIG: Record<Provider, { model: string; thinking: string }> = {
  claude: { model: 'claude-fable-5-1[1m]', thinking: 'max' }, codex: { model: 'gpt-6-astra', thinking: 'ultra' },
};
/** Claude Code accepts short aliases; Codex chats use the configured model or an explicit identifier. */
const MODEL_ALIASES: Record<Provider, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: [] };

/** Saved threads for this workspace, newest first; unfolds from the History control in the toolbar. */
function PlanningChatHistory({ currentId, onOpen, onClose }: { currentId: string; onOpen: (id: string) => void; onClose: () => void }) {
  const [chats, setChats] = useState<PlanningChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const load = async () => {
    try { setChats(await api<PlanningChatSummary[]>('/planning-chats')); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load planning threads.'); }
  };
  useEffect(() => { void load(); }, []);
  async function discard(id: string) {
    setDiscarding(id);
    try { await api(`/planning-chats/${id}`, 'DELETE', {}); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not discard this thread.'); }
    finally { setDiscarding(null); }
  }
  const others = (chats ?? []).filter(chat => chat.id !== currentId);
  return <div className="planning-history" role="dialog" aria-label="Past planning threads">
    <div className="planning-history-heading"><History size={14} /><strong>Past planning threads</strong><Button variant="ghost" size="icon" aria-label="Close history" onClick={onClose}><X size={15} /></Button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!chats ? <p className="planning-history-empty"><Loader2 size={14} className="spin" />Loading…</p>
      : others.length === 0 ? <p className="planning-history-empty">No other saved threads. Threads stay here until you discard them or turn them into a task.</p>
      : <ul>{others.map(chat => <li key={chat.id}>
        <button className="planning-history-item" onClick={() => onOpen(chat.id)}>
          <strong>{chat.title}</strong>
          <small>{chat.preview || 'No messages yet'}</small>
          <span>{PROVIDER_LABELS[chat.provider]} · {chat.messageCount} {chat.messageCount === 1 ? 'message' : 'messages'} · {relativeTime(chat.updatedAt)}{chat.busy ? ' · replying' : ''}{chat.taskIds.length ? ` · ${chat.taskIds.length} ${chat.taskIds.length === 1 ? 'task' : 'tasks'} created` : ''}</span>
        </button>
        <Button variant="ghost" size="icon" aria-label={`Discard thread ${chat.title}`} title="Discard thread" disabled={discarding === chat.id} onClick={() => void discard(chat.id)}><Trash2 size={14} /></Button>
      </li>)}</ul>}
  </div>;
}

export function PlanningChatView({ chatId, snapshot, onClose, onTaskified, onNewChat, creatingChat, actionsSlot, onOpenChat, onOpenTask }: { chatId: string; snapshot: AppSnapshot; onClose: () => void; onTaskified: (task: Task) => void; onNewChat: () => Promise<void>; creatingChat: boolean; /** The page heading's action area, where History, Discard, and Taskify render. */ actionsSlot: HTMLElement | null; onOpenChat: (id: string) => void; onOpenTask: (task: Task) => void }) {
  const [chat, setChat] = useState<PlanningChat | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskify, setTaskify] = useState(false);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingChat, setMissingChat] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const modelSelect = useRef<HTMLSelectElement>(null);
  const provider: Provider = chat?.provider ?? 'claude';
  const chatConfig = snapshot.runtime.config?.[provider] ?? FALLBACK_CONFIG[provider];
  const model = chat?.model ?? chatConfig.model;
  const modelOptions = [...new Set([chatConfig.model, model, ...MODEL_ALIASES[provider]])];
  const modelDisabled = !chat || busy || savingModel || chat.busy;
  const providerDetected = snapshot.runtime.providers[provider];
  const scroll = useConversationScroll({
    conversationKey: JSON.stringify([snapshot.scope.accountId, snapshot.scope.workspaceId, 'planning', chatId]),
    messages: chat?.messages ?? [],
    ready: Boolean(chat),
  });
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
      setChat(loaded); setError(null); setMissingChat(false);
    } catch (cause) {
      if (mutationVersion !== chatMutationVersion.current || loadVersion < appliedChatLoadVersion.current) return;
      appliedChatLoadVersion.current = loadVersion;
      const missing = cause instanceof ApiError && cause.status === 404;
      setMissingChat(missing);
      if (missing) setChat(null);
      setError(cause instanceof Error ? cause.message : 'This planning chat is no longer available.');
    }
  };
  useEffect(() => { void load(); }, [chatId]);
  useEffect(() => {
    if (!chat?.busy) return;
    const timer = setInterval(() => { void load(); }, 1200);
    return () => clearInterval(timer);
  }, [chat?.busy, chatId]);
  // Announce a reply that arrived while this chat was waiting; replies already present when the chat opened stay quiet.
  const lastAssistantId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!chat) return;
    const latest = chat.messages.findLast(message => message.role === 'assistant')?.id ?? null;
    if (lastAssistantId.current !== undefined && latest && latest !== lastAssistantId.current) {
      deliverNotification({ kind: 'planning', title: 'Planning partner replied', body: chat.messages.find(message => message.id === latest)?.content.replace(/\s+/g, ' ').trim().slice(0, 140) ?? '', tag: `planning:${latest}` }, () => window.focus());
    }
    lastAssistantId.current = latest;
  }, [chat]);
  function closeModelEdit() {
    setCustomModel(false);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) modelSelect.current?.focus();
    });
  }
  async function saveSelection(patch: { model?: string | null; provider?: Provider; effort?: string | null }) {
    if (modelDisabled) return;
    ++chatMutationVersion.current;
    setSavingModel(true);
    setModelError(null);
    try {
      const saved = await api<PlanningChat>(`/planning-chats/${chatId}`, 'PATCH', patch);
      // Older polls must not replace the selection confirmed by this save.
      ++chatMutationVersion.current;
      setChat(saved);
      closeModelEdit();
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : 'Could not save the planning chat agent.');
    } finally {
      setSavingModel(false);
    }
  }
  const saveModel = (nextModel: string) => saveSelection({ model: nextModel === chatConfig.model ? null : nextModel });
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!content.trim() || modelDisabled || customModel) return;
    ++chatMutationVersion.current;
    setBusy(true); setSendError(null);
    const intent = scroll.beginSend();
    try {
      const message = await api<PlanningChatMessage>(`/planning-chats/${chatId}/messages`, 'POST', { content: content.trim() });
      scroll.acceptSend(intent, message.id);
      setContent('');
      await load();
    }
    catch (cause) { setSendError(cause instanceof Error ? cause.message : 'Could not send your message.'); }
    finally { setBusy(false); }
  }
  async function discard() {
    if (chat?.messages.length && !window.confirm('Discard this planning thread? Its messages are deleted; documents and tasks it created stay.')) return;
    try { await api(`/planning-chats/${chatId}`, 'DELETE', {}); }
    catch (cause) { if (!(cause instanceof ApiError) || cause.status !== 404) { setSendError(cause instanceof Error ? cause.message : 'Could not discard this thread.'); return; } }
    onClose();
  }
  const firstQuestion = chat?.messages.find(message => message.role === 'user')?.content ?? '';
  // The partner's latest proposal prefills Taskify; the first question is the fallback title.
  const proposal = proposedTaskFromReply(chat?.messages.findLast(message => message.role === 'assistant')?.content);
  const initialTitle = proposal?.title ?? (firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New task');
  // The thread's controls sit in the page heading's action slot, where the chief view shows New task.
  const actions = <>
    <Button variant="ghost" size="icon" aria-label="Discard thread" title="Discard thread" disabled={!chat || chat.busy || busy} onClick={() => void discard()}><Trash2 size={15} /></Button>
    <Button variant="secondary" aria-label="Past planning threads" aria-expanded={history} title="Past planning threads" onClick={() => setHistory(value => !value)}><History size={15} />History</Button>
    <Button aria-label="Taskify conversation" onClick={() => setTaskify(true)} disabled={modelDisabled || !chat?.messages.length}><CheckCircle2 size={15} />Taskify</Button>
  </>;
  return <div className="planning-chat-view">
    {actionsSlot && createPortal(actions, actionsSlot)}
    {history && <PlanningChatHistory currentId={chatId} onOpen={id => { setHistory(false); onOpenChat(id); }} onClose={() => setHistory(false)} />}
    <ConversationViewport scroll={scroll} className="chief-conversation planning-chat-conversation" label="Planning conversation">
      {!chat && !error && <div className="planning-chat-empty"><Loader2 size={18} className="spin" />Opening planning thread…</div>}
      {error && <div className="planning-chat-empty"><FileText size={20} /><strong>{missingChat ? 'This planning chat is no longer available.' : error}</strong>{missingChat && <><p>It was discarded or turned into a task. Past threads are under History.</p><Button disabled={creatingChat} onClick={() => void onNewChat()}>{creatingChat ? 'Opening chat…' : 'Start new chat'}</Button></>}<Button variant="secondary" onClick={onClose}>Return to tasks</Button></div>}
      {chat && !chat.messages.length && <div className="chief-welcome"><div className="chief-orb"><MuonMark /></div><span className="eyebrow">YOUR PLANNING PARTNER</span><h2>What are you thinking about?</h2><p>Explore the problem first, read-only.<br />When it is clear, Taskify turns the conversation into a task.</p></div>}
      {chat && chat.messages.length > 0 && <div className="chief-messages">{chat.messages.map(message => <article key={message.id} data-message-id={message.id} className={`chief-message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <MuonMark small /> : 'Y'}</div><div className="message-content"><ConversationUnreadBoundary scroll={scroll} messageId={message.id} /><div className="message-author">{message.role === 'assistant' ? 'Planning partner' : 'You'}{message.role === 'assistant' && <span>{PROVIDER_LABELS[provider]} · Read-only</span>}</div><Markdown>{message.content}</Markdown>{Boolean(message.taskIds?.length) && <div className="message-task-links">{message.taskIds?.map(id => { const task = snapshot.tasks.find(item => item.id === id); return task ? <button key={id} onClick={() => onOpenTask(task)}><span>{task.identifier}</span>{task.title}<ArrowRight size={13} /></button> : null; })}</div>}</div></article>)}</div>}
      {chat?.error && <p className="form-error" role="alert">{chat.error}</p>}
      {chat?.busy && <div className="chief-working"><span className="working-dots"><i /><i /><i /></span>{chat.activity ?? 'Planning partner is thinking…'}</div>}
    </ConversationViewport>
    <div className="chief-composer-wrap">
      {!providerDetected && <p className="form-notice">{PROVIDER_LABELS[provider]} is not detected. Install it, sign in, and restart the local server, or choose another agent below.</p>}
      {sendError && <p className="form-error" role="alert">{sendError}</p>}
      {error === null && <form className="chief-composer" onSubmit={send}>
        <label htmlFor="planning-chat-message" className="sr-only">Message your planning partner</label>
        <MentionTextarea id="planning-chat-message" maxLength={30000} rows={2} placeholder="Ask a question or describe the idea… @ mentions a Library document" value={content} onChange={setContent} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} />
        <div className="composer-bottom chief-composer-bottom">
          <div className="chief-runtime-meta">
            <span><span className="provider-symbol" aria-hidden="true">{PROVIDER_SYMBOLS[provider]}</span><select className="chief-model-control planning-chat-provider" aria-label="Planning chat agent" value={provider} disabled={modelDisabled || customModel} onChange={event => { setModelError(null); void saveSelection({ provider: event.target.value as Provider }); }}>
              {(['claude', 'codex'] as const).map(option => <option key={option} value={option}>{PROVIDER_LABELS[option]}{snapshot.runtime.providers[option] ? '' : ' (not detected)'}</option>)}
            </select></span>
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
            <span>Thinking:<EffortSelect provider={provider} value={chat?.effort} defaultLevel={chatConfig.thinking} disabled={modelDisabled || customModel} label="Planning chat thinking effort" onChange={effort => { setModelError(null); void saveSelection({ effort }); }} /></span>
          </div>
          <Button size="icon" aria-label="Send message" type="submit" disabled={!content.trim() || modelDisabled || customModel}><ArrowUp size={17} /></Button>
        </div>
        {modelError && <p id="planning-chat-model-error" className="form-error chief-model-error" role="alert">{modelError}</p>}
        {savingModel && <span className="sr-only" role="status">Saving selection…</span>}
      </form>}
      {error === null && <p className="composer-hint">Read-only in your repository; documents and tasks it creates land in the workspace.<span>Enter to send · Shift + Enter for a new line</span></p>}
    </div>
    <TaskDialog key={chatId} open={taskify} onOpenChange={setTaskify} snapshot={snapshot} initialTitle={initialTitle} initialDescription={proposal?.description ?? ''} planningChatId={chatId} onCreated={onTaskified} />
  </div>;
}
