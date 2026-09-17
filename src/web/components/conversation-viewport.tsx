import type { ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import type { ConversationScroll } from '../lib/conversation-scroll';
import '../conversation-scroll.css';

export function ConversationViewport({ scroll, className, label, children }: {
  scroll: ConversationScroll;
  className: string;
  label: string;
  children: ReactNode;
}) {
  function navigate(action: () => void) {
    action();
    scroll.viewportRef.current?.focus({ preventScroll: true });
  }
  return <div className="conversation-viewport">
    <div ref={scroll.viewportRef} className={`${className} conversation-scroll-region`} role="log" aria-label={label} aria-live="polite" aria-relevant="additions" tabIndex={0}>
      <div ref={scroll.contentRef} className="conversation-scroll-content">{children}</div>
    </div>
    <span className="sr-only" role="status">{scroll.unreadCount ? `${scroll.unreadCount} new ${scroll.unreadCount === 1 ? 'message' : 'messages'}` : ''}</span>
    {scroll.detached && <div className="conversation-catch-up" aria-label="Conversation navigation">
      {scroll.unreadCount > 0 && <button type="button" onClick={() => navigate(scroll.jumpToUnread)}>{scroll.unreadCount} new {scroll.unreadCount === 1 ? 'message' : 'messages'}</button>}
      <button type="button" onClick={() => navigate(scroll.jumpToLatest)}><ArrowDown size={13} aria-hidden="true" />Jump to latest</button>
    </div>}
  </div>;
}

export function ConversationUnreadBoundary({ scroll, messageId }: { scroll: ConversationScroll; messageId: string }) {
  return scroll.firstUnreadId === messageId ? <div className="conversation-unread-boundary" role="separator" aria-label="New messages"><span>New messages</span></div> : null;
}
