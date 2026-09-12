import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, Loader2, MessageSquare, RotateCcw } from 'lucide-react';
import type { CommentOnTaskInput, Task } from '../../shared/types';
import { taskCommentState } from '../lib/task-comments';
import { relativeTime } from '../lib/utils';
import { Markdown } from './common';
import { Button } from './ui/button';

export function TaskComments({ task, userId, dispatcherEnabled, active, busy, error, onComment, onRetry }: {
  task: Task;
  userId: string;
  dispatcherEnabled: boolean;
  active: boolean;
  busy: boolean;
  error: string | null;
  onComment: (input: CommentOnTaskInput) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<NonNullable<CommentOnTaskInput['mode']>>('message');
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const pendingRequest = useRef<CommentOnTaskInput | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);
  const comments = task.comments ?? [];
  const state = taskCommentState(task, userId, dispatcherEnabled, busy || sending || retrying);
  const provider = task.provider === 'claude' ? 'Claude Code' : 'Codex';
  const followUp = task.followUp;
  const failed = followUp?.status === 'failed';
  const hint = task.status === 'canceled' ? 'This task is canceled. Its conversation remains available.'
    : !state.isOwner ? 'Only the task owner can send comments.'
    : state.waitingForStart ? 'Your comments will be saved for planning when this task starts.'
    : mode === 'replan' ? 'The agent will prepare a new RFC. You must approve it before further implementation.'
    : task.runId ? 'The agent will pause, reply, and continue the approved work.'
    : 'Ask about the task or its result. Choose Revise RFC to request more work.';
  useEffect(() => {
    if (active && wasNearBottom.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [active, comments.length, followUp?.status]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !state.canComment || sending) return;
    const previous = pendingRequest.current;
    // Reuse the key when a response was lost, so resending cannot duplicate the comment.
    const request = previous?.content === content && previous.mode === mode ? previous : { content, mode, requestId: crypto.randomUUID() };
    pendingRequest.current = request;
    setSending(true);
    try {
      if (await onComment(request)) {
        setDraft('');
        pendingRequest.current = null;
        wasNearBottom.current = true;
      }
    } finally { setSending(false); }
  }

  async function retry() {
    if (!state.canRetry || retrying) return;
    setRetrying(true);
    try { await onRetry(); }
    finally { setRetrying(false); }
  }

  return <section className="task-comments" aria-label="Task comments">
    <div className="task-comments-heading">
      <MessageSquare size={19} aria-hidden="true" />
      <div><h3>Task conversation</h3><p>{provider} · Comments and replies stay with this task</p></div>
    </div>
    <div className="task-comments-messages" ref={conversation} role="log" aria-label="Task conversation" aria-live="polite" tabIndex={0} onScroll={() => {
      const element = conversation.current;
      if (element) wasNearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      {comments.length === 0 ? <div className="task-comments-empty"><h4>Keep the conversation with the work</h4><p>Ask a question, add context, or request a revised RFC. The agent’s replies appear here.</p></div> : comments.map(comment => <article key={comment.id} className={`task-comment ${comment.role}`}>
        <div className="task-comment-meta">
          <span className="task-comment-avatar" aria-hidden="true">{comment.role === 'user' ? 'Y' : task.provider === 'claude' ? '✳' : '⌘'}</span>
          <strong>{comment.role === 'user' ? comment.userId === userId ? 'You' : 'Owner' : provider}</strong>
          <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>{relativeTime(comment.createdAt)}</time>
        </div>
        {comment.role === 'assistant' && comment.content.length > 3000 ? <details className="task-comment-long"><summary>Read agent’s reply</summary><Markdown>{comment.content}</Markdown></details> : <Markdown>{comment.content}</Markdown>}
      </article>)}
    </div>
    {state.statusLabel && <div className={`task-comments-status${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'}>
      {failed ? <AlertTriangle size={16} aria-hidden="true" /> : followUp?.status === 'queued' ? <RotateCcw size={16} aria-hidden="true" /> : <Loader2 size={16} className="spin" aria-hidden="true" />}
      <div><strong>{state.statusLabel}</strong><p>{state.statusDescription}</p></div>
      {failed && state.isOwner && task.status !== 'canceled' && <Button variant="secondary" size="sm" disabled={!state.canRetry} onClick={() => void retry()}><RotateCcw size={13} aria-hidden="true" />{retrying ? 'Queuing…' : followUp?.mode === 'replan' ? 'Retry revision' : 'Retry reply'}</Button>}
    </div>}
    <div className="task-comments-controls">
      {error && <p className="form-error" role="alert">{error}</p>}
      <form className="task-comments-composer" onSubmit={send}>
        <div className="task-comments-composer-heading">
          <label htmlFor={`task-comment-${task.id}`}>Comment on this task</label>
          <select aria-label="Comment action" value={mode} disabled={!state.canComment} onChange={event => setMode(event.target.value === 'replan' ? 'replan' : 'message')}>
            <option value="message">Message agent</option>
            <option value="replan">Revise RFC</option>
          </select>
        </div>
        <textarea id={`task-comment-${task.id}`} aria-describedby={`task-comment-hint-${task.id}`} placeholder={mode === 'replan' ? 'Describe what should change in the RFC…' : 'Ask a question or add context…'} rows={3} maxLength={20000} value={draft} disabled={!state.canComment} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send(event);
          }
        }} />
        <div className="task-comments-composer-bottom"><span>Enter to send · Shift+Enter for a new line</span><Button size="icon" type="submit" aria-label="Send task comment" disabled={!state.canComment || !draft.trim()}>{sending ? <Loader2 size={17} className="spin" aria-hidden="true" /> : <ArrowUp size={17} aria-hidden="true" />}</Button></div>
      </form>
      <p className="task-comments-hint" id={`task-comment-hint-${task.id}`}>{hint}</p>
    </div>
  </section>;
}
