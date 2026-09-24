import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, CheckCircle2, ChevronRight, FileText, Loader2, PanelLeft, X } from 'lucide-react';
import type { AppSnapshot, PlanningChat, PlanningChatMessage, Provider, Task } from '../../shared/types';
import { ApiError } from '../../shared/api-client';
import { api } from '../lib/api';
import { useConversationScroll } from '../lib/conversation-scroll';
import { deliverNotification } from '../lib/notifications';
import { Markdown, MuonMark } from './common';
import { ConversationUnreadBoundary, ConversationViewport } from './conversation-viewport';
import { Button } from './ui/button';
import { TaskDialog } from './task-dialog';

const PROVIDER_LABELS: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };
const PROVIDER_SYMBOLS: Record<Provider, string> = { claude: '✳', codex: '⌘' };
const FALLBACK_CONFIG: Record<Provider, { model: string; thinking: string }> = {
  claude: { model: 'claude-fable-5-1[1m]', thinking: 'max' }, codex: { model: 'gpt-6-astra', thinking: 'ultra' },
};
/** Claude Code accepts short aliases; Codex chats use the configured model or an explicit identifier. */
const MODEL_ALIASES: Record<Provider, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: [] };

export function PlanningChatView({ chatId, snapshot, onClose, onTaskified, onNewChat, creatingChat, onOpenNavigation }: { chatId: string; snapshot: AppSnapshot; onClose: () => void; onTaskified: (task: Task) => void; onNewChat: () => Promise<void>; creatingChat: boolean; onOpenNavigation: () => void }) {
  const [chat, setChat] = useState<PlanningChat | null>(null);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [taskify, setTaskify] = useState(false);
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
    conversationKey: JSON.stringify([snapshot.scope.workspaceId, snapshot.scope.projectId, 'planning', chatId]),
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
  async function saveSelection(patch: { model?: string | null; provider?: Provider }) {
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
  const firstQuestion = chat?.messages.find(message => message.role === 'user')?.content ?? '';
  const initialTitle = firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New task';
  return <div className="planning-chat-view">
    <header className="planning-chat-toolbar">
      <Button variant="ghost" size="icon" className="mobile-menu" aria-label="Open navigation" onClick={onOpenNavigation}><PanelLeft size={17} /></Button>
      <Button variant="ghost" size="icon" aria-label="Back to tasks" title="Back to tasks" onClick={onClose}><ArrowLeft size={15} /></Button>
      <div className="planning-chat-title"><span title={snapshot.project.name}>{snapshot.project.name}</span><ChevronRight size={12} aria-hidden="true" /><h1>Planning thread</h1></div>
      {snapshot.runtime.demo && <span className="demo-badge">Demo workspace</span>}
      <Button size="sm" aria-label="Taskify conversation" onClick={() => setTaskify(true)} disabled={modelDisabled || !chat?.messages.length}><CheckCircle2 size={15} />Taskify</Button>
    </header>
    <ConversationViewport scroll={scroll} className="planning-chat-conversation" label="Planning conversation">
      {!chat && !error && <div className="planning-chat-empty"><Loader2 size={18} className="spin" />Opening planning thread…</div>}
      {error && <div className="planning-chat-empty"><FileText size={20} /><strong>{missingChat ? 'This planning chat is no longer available.' : error}</strong>{missingChat && <><p>It may have been discarded or lost when the server restarted.</p><Button disabled={creatingChat} onClick={() => void onNewChat()}>{creatingChat ? 'Opening chat…' : 'Start new chat'}</Button></>}<Button variant="secondary" onClick={onClose}>Return to tasks</Button></div>}
      {chat && !chat.messages.length && <div className="planning-chat-empty"><div className="chief-orb"><MuonMark /></div><h2>What are you thinking about?</h2><p>Explore the problem first. I’ll help turn the conversation into a clear task when you’re ready.</p></div>}
      {chat?.messages.map(message => <article key={message.id} data-message-id={message.id} className={`chief-message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <MuonMark small /> : 'Y'}</div><div className="message-content"><ConversationUnreadBoundary scroll={scroll} messageId={message.id} /><div className="message-author">{message.role === 'assistant' ? 'Planning partner' : 'You'}{message.role === 'assistant' && <span>{PROVIDER_LABELS[provider]} · Read-only</span>}</div><Markdown>{message.content}</Markdown></div></article>)}
      {chat?.error && <p className="form-error" role="alert">{chat.error}</p>}
      {chat?.busy && <div className="chief-working"><span className="working-dots"><i /><i /><i /></span>{chat.activity ?? 'Planning partner is thinking…'}</div>}
    </ConversationViewport>
    <div className="planning-chat-composer-wrap">
      {!providerDetected && <p className="form-notice">{PROVIDER_LABELS[provider]} is not detected. Install it, sign in, and restart the local server, or choose another agent below.</p>}
      {sendError && <p className="form-error" role="alert">{sendError}</p>}
      {error === null && <form className="chief-composer" onSubmit={send}>
        <label htmlFor="planning-chat-message" className="sr-only">Message your planning partner</label>
        <textarea id="planning-chat-message" maxLength={30000} rows={2} placeholder="Ask a question or describe the idea…" value={content} onChange={event => setContent(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(event); } }} />
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
            <span>Thinking: {chatConfig.thinking}</span>
          </div>
          <Button size="icon" aria-label="Send message" type="submit" disabled={!content.trim() || modelDisabled || customModel}><ArrowUp size={17} /></Button>
        </div>
        {modelError && <p id="planning-chat-model-error" className="form-error chief-model-error" role="alert">{modelError}</p>}
        {savingModel && <span className="sr-only" role="status">Saving selection…</span>}
      </form>}
    </div>
    <TaskDialog key={chatId} open={taskify} onOpenChange={setTaskify} snapshot={snapshot} initialTitle={initialTitle} initialDescription="" planningChatId={chatId} onCreated={onTaskified} />
  </div>;
}
