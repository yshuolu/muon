import { useLayoutEffect, useMemo, useRef, useState } from 'react';

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
}

interface ReadingAnchor {
  id: string;
  offset: number;
  index: number;
}

interface ConversationPosition {
  initialized: boolean;
  following: boolean;
  anchor: ReadingAnchor | null;
  ids: string[];
  known: Set<string>;
  unseen: Set<string>;
  boundary: string | null;
  expanded: Set<string>;
  acceptedSends: Set<string>;
}

interface ScrollView {
  detached: boolean;
  unreadCount: number;
  firstUnreadId: string | null;
}

export interface ConversationSendIntent {
  readonly epoch: number;
  readonly form: HTMLFormElement | null;
  readonly focusOrigin: Element | null;
  allowFocus: boolean;
}

const FOLLOW_DISTANCE = 80;
const MAX_SAVED_CONVERSATIONS = 100;
const savedPositions = new Map<string, ConversationPosition>();

function positionFor(key: string): ConversationPosition {
  const previous = savedPositions.get(key);
  if (previous) {
    savedPositions.delete(key);
    savedPositions.set(key, previous);
    return previous;
  }
  const position: ConversationPosition = {
    initialized: false, following: true, anchor: null, ids: [], known: new Set(),
    unseen: new Set(), boundary: null, expanded: new Set(), acceptedSends: new Set(),
  };
  savedPositions.set(key, position);
  if (savedPositions.size > MAX_SAVED_CONVERSATIONS) {
    const oldest = savedPositions.keys().next().value;
    if (oldest !== undefined) savedPositions.delete(oldest);
  }
  return position;
}

// One owner for scroll writes prevents polling, layout observers, and sends from
// applying competing policies. The cache lasts only as long as this app page.
class ConversationScrollController {
  private readonly position: ConversationPosition;
  private viewport: HTMLDivElement | null = null;
  private content: HTMLDivElement | null = null;
  private active = true;
  private ready = false;
  private visible = false;
  private epoch = 0;
  private pendingSend: { intent: ConversationSendIntent; messageId: string } | null = null;
  private sendIntent: ConversationSendIntent | null = null;
  private frame = 0;
  private focusFrame = 0;
  private expectedTop = 0;
  private userInput = false;
  private inputTimer: ReturnType<typeof setTimeout> | undefined;
  private geometry = '';
  private layoutDirty = true;
  private restoredDetails = new WeakSet<HTMLDetailsElement>();
  private onView: ((view: ScrollView) => void) | null = null;
  private view: ScrollView = { detached: false, unreadCount: 0, firstUnreadId: null };

  constructor(key: string) { this.position = positionFor(key); }

  connect(viewport: HTMLDivElement, content: HTMLDivElement, onView: (view: ScrollView) => void) {
    this.viewport = viewport;
    this.content = content;
    this.onView = onView;
    onView(this.view);
    const resize = new ResizeObserver(this.onLayoutChange);
    resize.observe(viewport);
    resize.observe(content);
    // ResizeObserver can coalesce a shrink/grow back to the original size.
    // Keep the intervening DOM layout changes until scroll writes settle too.
    const mutations = new MutationObserver(this.onLayoutChange);
    mutations.observe(viewport.closest('main') ?? viewport.parentElement ?? viewport, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open'],
    });
    viewport.addEventListener('scroll', this.onScroll, { passive: true });
    viewport.addEventListener('scrollend', this.endUserInput);
    viewport.addEventListener('wheel', this.onUserInput, { passive: true });
    viewport.addEventListener('touchmove', this.onUserInput, { passive: true });
    viewport.addEventListener('pointerdown', this.onScrollbarPointer);
    viewport.addEventListener('keydown', this.onKeyDown);
    content.addEventListener('click', this.onDetailsClick, true);
    content.addEventListener('toggle', this.onDetailsToggle, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('focusin', this.onFocusChange);
    document.addEventListener('pointerdown', this.onFocusChange);
    return () => {
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(this.frame);
      cancelAnimationFrame(this.focusFrame);
      clearTimeout(this.inputTimer);
      viewport.removeEventListener('scroll', this.onScroll);
      viewport.removeEventListener('scrollend', this.endUserInput);
      viewport.removeEventListener('wheel', this.onUserInput);
      viewport.removeEventListener('touchmove', this.onUserInput);
      viewport.removeEventListener('pointerdown', this.onScrollbarPointer);
      viewport.removeEventListener('keydown', this.onKeyDown);
      content.removeEventListener('click', this.onDetailsClick, true);
      content.removeEventListener('toggle', this.onDetailsToggle, true);
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.removeEventListener('focusin', this.onFocusChange);
      document.removeEventListener('pointerdown', this.onFocusChange);
      this.viewport = null;
      this.content = null;
      this.onView = null;
      this.visible = false;
      this.frame = 0;
    };
  }

  update(messages: readonly ConversationMessage[], active: boolean, ready: boolean) {
    this.active = active;
    this.ready = ready;
    if (!ready || !this.viewport) {
      this.visible = false;
      this.publish();
      return;
    }
    const position = this.position;
    const changed = position.ids.length !== messages.length || messages.some((message, index) => position.ids[index] !== message.id);
    for (const message of messages) {
      if (position.initialized && !position.known.has(message.id) && message.role === 'assistant') {
        position.unseen.add(message.id);
        position.boundary ??= message.id;
      }
      position.known.add(message.id);
    }
    position.ids = messages.map(message => message.id);
    const currentIds = new Set(position.ids);
    for (const id of position.unseen) if (!currentIds.has(id)) position.unseen.delete(id);
    if (position.boundary && !currentIds.has(position.boundary)) position.boundary = this.firstUnseen();
    position.initialized = true;
    this.restoreDetails();
    const wasVisible = this.visible;
    this.updateVisibility();
    if (this.visible && (changed || !wasVisible || this.pendingSend)) this.reconcile();
    this.publish();
  }

  beginSend = (): ConversationSendIntent => {
    const focused = document.activeElement;
    const intent: ConversationSendIntent = {
      epoch: this.epoch,
      form: focused instanceof HTMLElement ? focused.closest('form') : null,
      focusOrigin: focused,
      allowFocus: true,
    };
    this.sendIntent = intent;
    return intent;
  };

  acceptSend = (intent: ConversationSendIntent, messageId: string) => {
    const alreadyAccepted = this.position.acceptedSends.has(messageId);
    this.position.acceptedSends.add(messageId);
    if (this.position.acceptedSends.size > 100) {
      const oldest = this.position.acceptedSends.values().next().value;
      if (oldest !== undefined) this.position.acceptedSends.delete(oldest);
    }
    if (!alreadyAccepted && intent.epoch === this.epoch) {
      this.pendingSend = { intent, messageId };
      this.reconcile();
    }
    cancelAnimationFrame(this.focusFrame);
    this.focusFrame = requestAnimationFrame(() => {
      const input = intent.form?.querySelector('textarea');
      const focused = document.activeElement;
      if (this.visible && intent.allowFocus && input?.isConnected && !input.disabled &&
          (focused === document.body || focused instanceof Node && intent.form?.contains(focused))) {
        input.focus({ preventScroll: true });
      }
      if (this.sendIntent === intent) this.sendIntent = null;
    });
  };

  jumpToLatest = () => {
    ++this.epoch;
    this.pendingSend = null;
    this.position.following = true;
    this.position.unseen.clear();
    this.position.boundary = null;
    this.reconcile();
  };

  jumpToUnread = () => {
    const id = this.firstUnseen();
    if (!id) { this.jumpToLatest(); return; }
    ++this.epoch;
    this.pendingSend = null;
    this.position.following = false;
    this.position.anchor = { id, offset: 8, index: this.position.ids.indexOf(id) };
    this.reconcile();
  };

  private rows() {
    return Array.from(this.content?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []);
  }

  private firstUnseen() {
    return this.position.ids.find(id => this.position.unseen.has(id)) ?? null;
  }

  private captureAnchor(): ReadingAnchor | null {
    const viewport = this.viewport;
    if (!viewport?.clientHeight) return this.position.anchor;
    const bounds = viewport.getBoundingClientRect();
    const row = this.rows().find(item => item.getBoundingClientRect().bottom > bounds.top + 1 && item.getBoundingClientRect().top < bounds.bottom);
    const id = row?.dataset.messageId;
    return row && id ? { id, offset: row.getBoundingClientRect().top - bounds.top, index: this.position.ids.indexOf(id) } : this.position.anchor;
  }

  private restoreAnchor() {
    const viewport = this.viewport;
    const anchor = this.position.anchor;
    if (!viewport || !anchor) return;
    const rows = this.rows();
    const row = rows.find(item => item.dataset.messageId === anchor.id) ?? rows[Math.min(Math.max(anchor.index, 0), rows.length - 1)];
    if (!row) return;
    const bounds = row.getBoundingClientRect();
    const offset = Math.max(anchor.offset, -Math.max(0, bounds.height - 1));
    viewport.scrollTop += bounds.top - viewport.getBoundingClientRect().top - offset;
  }

  private geometryKey() {
    const viewport = this.viewport;
    return viewport ? `${viewport.clientWidth}:${viewport.clientHeight}:${viewport.scrollHeight}` : '';
  }

  private updateVisibility() {
    const visible = this.active && !document.hidden && Boolean(this.viewport?.clientHeight) && !this.viewport?.closest('[inert]');
    if (visible && !this.visible && this.position.following && this.position.unseen.size) {
      const id = this.firstUnseen();
      if (id) {
        this.position.following = false;
        this.position.anchor = { id, offset: 8, index: this.position.ids.indexOf(id) };
      }
    }
    this.visible = visible;
  }

  private reconcile = () => {
    this.updateVisibility();
    const viewport = this.viewport;
    if (!this.ready || !this.visible || !viewport) return;
    const pending = this.pendingSend;
    if (pending) {
      if (pending.intent.epoch !== this.epoch) this.pendingSend = null;
      else {
        if (this.position.ids.includes(pending.messageId)) {
          this.position.following = true;
          this.pendingSend = null;
        }
      }
    }
    if (this.position.following) {
      viewport.scrollTop = viewport.scrollHeight;
      this.position.unseen.clear();
      this.position.boundary = null;
    } else this.restoreAnchor();
    this.expectedTop = viewport.scrollTop;
    this.geometry = this.geometryKey();
    this.layoutDirty = false;
    this.position.anchor = this.captureAnchor();
    this.markVisible();
    this.publish();
  };

  private schedule = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.reconcile(); });
  };

  private onLayoutChange = () => {
    this.layoutDirty = true;
    this.schedule();
  };

  private markVisible() {
    if (!this.visible || !this.viewport) return;
    const bounds = this.viewport.getBoundingClientRect();
    for (const row of this.rows()) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.top && rect.top < bounds.bottom && row.dataset.messageId) {
        this.position.unseen.delete(row.dataset.messageId);
      }
    }
  }

  private publish() {
    const next: ScrollView = {
      detached: this.ready && !this.position.following,
      unreadCount: this.ready ? this.position.unseen.size : 0,
      firstUnreadId: this.ready ? this.position.boundary : null,
    };
    if (next.detached !== this.view.detached || next.unreadCount !== this.view.unreadCount || next.firstUnreadId !== this.view.firstUnreadId) {
      this.view = next;
      this.onView?.(next);
    }
  }

  private onScroll = () => {
    const viewport = this.viewport;
    if (!this.visible || !viewport) return;
    // Browsers can clamp scrollTop when the viewport grows. That is a layout
    // event, not a request to stop following or to replace a reading anchor.
    if (!this.userInput && (this.layoutDirty || this.geometry !== this.geometryKey())) { this.schedule(); return; }
    if (Math.abs(viewport.scrollTop - this.expectedTop) > 1 || this.userInput) {
      ++this.epoch;
      this.pendingSend = null;
      this.position.following = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_DISTANCE;
      this.position.anchor = this.captureAnchor();
      if (this.position.following) {
        this.position.unseen.clear();
        this.position.boundary = null;
      }
      this.expireUserInput();
    }
    this.expectedTop = viewport.scrollTop;
    this.markVisible();
    this.publish();
  };

  private onUserInput = (event?: Event) => {
    if (event instanceof WheelEvent && event.deltaY === 0) return;
    this.userInput = true;
    ++this.epoch;
    this.pendingSend = null;
    this.expireUserInput();
  };

  private expireUserInput() {
    clearTimeout(this.inputTimer);
    // scrollend covers kinetic scrolling; the timeout also clears gestures
    // that reached a boundary without producing any scroll event.
    this.inputTimer = setTimeout(this.endUserInput, 200);
  }

  private endUserInput = () => { this.userInput = false; };

  private onScrollbarPointer = (event: PointerEvent) => {
    if (event.target === this.viewport) this.onUserInput(event);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, summary, [contenteditable="true"]')) return;
    if (event.key === 'End') {
      event.preventDefault();
      this.jumpToLatest();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      this.jumpToUnread();
    } else if (['Home', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' '].includes(event.key)) this.onUserInput();
  };

  private onVisibility = () => {
    this.updateVisibility();
    this.reconcile();
  };

  private onFocusChange = (event: Event) => {
    const intent = this.sendIntent;
    if (!intent || !(event.target instanceof Node) || event.target === document.body) return;
    const input = intent.form?.querySelector('textarea');
    const origin = intent.focusOrigin;
    if (event.target !== input && !(origin instanceof Node && origin.contains(event.target))) intent.allowFocus = false;
  };

  private restoreDetails() {
    for (const row of this.rows()) {
      const details = row.querySelector('details');
      if (!details || this.restoredDetails.has(details)) continue;
      this.restoredDetails.add(details);
      details.open = this.position.expanded.has(row.dataset.messageId!);
    }
  }

  private onDetailsClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const summary = event.target.closest('summary');
    const details = summary?.parentElement;
    const row = summary?.closest<HTMLElement>('[data-message-id]');
    if (!(details instanceof HTMLDetailsElement) || !row?.dataset.messageId || !this.viewport) return;
    ++this.epoch;
    this.pendingSend = null;
    this.position.following = false;
    this.position.anchor = { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top, index: this.position.ids.indexOf(row.dataset.messageId) };
    if (details.open) this.position.expanded.delete(row.dataset.messageId);
    else this.position.expanded.add(row.dataset.messageId);
    this.publish();
  };

  private onDetailsToggle = (event: Event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    const row = details.closest<HTMLElement>('[data-message-id]');
    if (!row?.dataset.messageId) return;
    if (details.open) this.position.expanded.add(row.dataset.messageId);
    else this.position.expanded.delete(row.dataset.messageId);
    this.schedule();
  };
}

export function useConversationScroll({ conversationKey, messages, active = true, ready = true }: {
  conversationKey: string;
  messages: readonly ConversationMessage[];
  active?: boolean;
  ready?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controller = useMemo(() => new ConversationScrollController(conversationKey), [conversationKey]);
  const [view, setView] = useState<ScrollView>({ detached: false, unreadCount: 0, firstUnreadId: null });
  useLayoutEffect(() => {
    if (viewportRef.current && contentRef.current) return controller.connect(viewportRef.current, contentRef.current, setView);
  }, [controller]);
  useLayoutEffect(() => { controller.update(messages, active, ready); });
  return { ...view, viewportRef, contentRef, beginSend: controller.beginSend, acceptSend: controller.acceptSend, jumpToLatest: controller.jumpToLatest, jumpToUnread: controller.jumpToUnread };
}

export type ConversationScroll = ReturnType<typeof useConversationScroll>;
