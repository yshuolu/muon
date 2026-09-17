import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowUpRight, Bell, Check, ChevronDown, ChevronRight, CircleDot, Command, Folder, LayoutGrid, List, Loader2, PanelLeft, Pause, Play, Plus, Settings2, Sparkles, X } from 'lucide-react';
import type { Task } from '../shared/types';
import { ApiError } from '../shared/api-client';
import { api, useWorkspace } from './lib/api';
import { visibleAttention } from './lib/utils';
import { AttentionView } from './components/attention';
import { ChiefView } from './components/chief';
import { MuonMark } from './components/common';
import { SettingsDialog } from './components/settings-dialog';
import { TaskDetail } from './components/task-detail';
import { TaskDialog } from './components/task-dialog';
import { TaskList } from './components/task-list';
import { PlanningChatView } from './components/planning-chat';
import { Button } from './components/ui/button';

type View = 'tasks' | 'attention' | 'chief' | 'planning-chat';
function locationState(): { view: View; taskId: string | null; chatId: string | null } {
  const segments = window.location.pathname.split('/').filter(Boolean);
  if (segments[0] === 'attention') return { view: 'attention', taskId: null, chatId: null };
  if (segments[0] === 'chief') return { view: 'chief', taskId: null, chatId: null };
  if (segments[0] === 'planning-chats') return { view: 'planning-chat', taskId: null, chatId: segments[1] ? decodeURIComponent(segments[1]) : null };
  if (segments[0] === 'tasks') return { view: 'tasks', taskId: segments[1] ? decodeURIComponent(segments[1]) : null, chatId: null };
  return { view: 'tasks', taskId: null, chatId: null };
}
function pathFor(view: View, taskId?: string | null): string {
  if (view === 'attention') return '/attention';
  if (view === 'chief') return '/chief';
  if (view === 'planning-chat') return taskId ? `/planning-chats/${encodeURIComponent(taskId)}` : '/planning-chats';
  return taskId ? `/tasks/${encodeURIComponent(taskId)}` : '/tasks';
}
export function App() {
  const { snapshot, error: connectionError, refresh } = useWorkspace();
  const initialLocation = useRef(locationState());
  const [view, setView] = useState<View>(initialLocation.current.view);
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(initialLocation.current.taskId);
  const [chatId, setChatId] = useState<string | null>(initialLocation.current.chatId);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigate = useCallback((nextView: View, taskId: string | null = null) => {
    const path = pathFor(nextView, taskId);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setView(nextView); setSelectedId(nextView === 'tasks' ? taskId : null); setChatId(nextView === 'planning-chat' ? taskId : null);
  }, []);
  const selectTask = (task: Task) => { if (!selectedId) returnFocus.current = document.activeElement as HTMLElement; navigate('tasks', task.id); };
  const closeTask = useCallback(() => { navigate(view); requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus()); }, [navigate, view]);
  const closePlanningChat = useCallback(() => { if (chatId) void api(`/planning-chats/${chatId}`, 'DELETE', {}).catch(() => undefined); navigate('tasks'); }, [chatId, navigate]);
  const [newTask, setNewTask] = useState(false);
  const [parent, setParent] = useState<Task | undefined>();
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const selected = snapshot?.tasks.find(task => task.id === selectedId);
  const unread = snapshot ? visibleAttention(snapshot).length : 0;
  const openCreate = async () => {
    if (creatingChat) return;
    setCreatingChat(true);
    setError(null);
    try {
      if (view === 'planning-chat' && chatId) {
        try { await api(`/planning-chats/${chatId}`, 'DELETE', {}); }
        catch (cause) {
          // Disposable chats disappear on restart or after being discarded in another tab.
          if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
        }
      }
      const chat = await api<{ id: string }>('/planning-chats', 'POST', {});
      navigate('planning-chat', chat.id);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open a planning thread.'); }
    finally { setCreatingChat(false); }
  };
  useEffect(() => {
    const handlePopState = () => { const next = locationState(); setView(next.view); setSelectedId(next.taskId); setChatId(next.chatId); setSidebarOpen(false); };
    window.addEventListener('popstate', handlePopState); return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'c') { event.preventDefault(); void openCreate(); }
      if (event.key === '/') { event.preventDefault(); document.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')?.focus(); }
      if (event.key === 'Escape') view === 'planning-chat' ? closePlanningChat() : closeTask();
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [closePlanningChat, closeTask, openCreate, view]);
  const go = (next: View) => { if (view === 'planning-chat' && chatId) void api(`/planning-chats/${chatId}`, 'DELETE', {}).catch(() => undefined); navigate(next); setSidebarOpen(false); };
  async function readAttention(id: string) {
    try { await api(`/attention/${id}/read`, 'POST', {}); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not dismiss notification.'); }
  }
  async function toggleDispatcher() {
    if (!snapshot) return; setDispatchBusy(true);
    try { await api('/settings', 'PATCH', { dispatcherEnabled: !snapshot.settings.dispatcherEnabled }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update dispatcher.'); }
    finally { setDispatchBusy(false); }
  }
  if (!snapshot) return <div className="startup-screen"><MuonMark />{connectionError ? <><h1>Let’s get your workspace connected</h1><p>{connectionError}</p><span>Make sure the local Muon server is running.</span><Button variant="secondary" onClick={() => void refresh()}>Try again</Button></> : <><h1>Opening your workspace</h1><Loader2 size={18} className="spin" /></>}</div>;
  const running = snapshot.tasks.filter(task => task.status === 'in_progress' && task.kind !== 'group').length;
  const reviews = snapshot.tasks.filter(task => task.status === 'in_review').length;
  const done = snapshot.tasks.filter(task => task.status === 'done').length;
  const todo = snapshot.tasks.filter(task => task.status === 'todo' && task.kind !== 'group').length;
  const title = view === 'tasks' ? 'All tasks' : view === 'attention' ? 'Attention' : view === 'chief' ? 'Chief of staff' : 'Planning thread';
  const compactPlanningChat = view === 'planning-chat' && chatId !== null;
  return <div className="app-shell">
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <button className="workspace-selector" onClick={() => setSettings(true)}><MuonMark /><span>Muon<span>Personal workspace</span></span><ChevronDown size={14} /></button>
      <div className="sidebar-create"><Button variant="secondary" onClick={() => void openCreate()} disabled={creatingChat}><Plus size={15} /><span>Create task</span><kbd>C</kbd></Button></div>
      <nav className="primary-nav" aria-label="Workspace"><button className={view === 'chief' ? 'active' : ''} onClick={() => go('chief')}><Sparkles size={16} /><span>Chief of staff</span>{snapshot.runtime.chiefRunning && <i className="chief-running-dot" />}</button><button className={view === 'attention' ? 'active' : ''} onClick={() => go('attention')}><Bell size={16} /><span>Attention</span>{unread > 0 && <span className="nav-badge">{unread}</span>}</button><button className={view === 'tasks' ? 'active' : ''} onClick={() => go('tasks')}><List size={17} /><span>All tasks</span><span className="nav-count">{snapshot.tasks.length}</span></button></nav>
      <div className="sidebar-section-heading"><span>Projects</span><button aria-label="Project settings" onClick={() => setSettings(true)}><Settings2 size={13} /></button></div>
      <nav className="project-nav" aria-label="Projects"><button onClick={() => go('tasks')}><ChevronDown size={12} /><span className="project-icon">{snapshot.project.name.slice(0, 1).toUpperCase()}</span><span>{snapshot.project.name}</span></button><button className="project-child" onClick={() => go('tasks')}><Folder size={14} />Tasks<span>{snapshot.tasks.length}</span></button></nav>
      <div className="sidebar-bottom"><div className="dispatcher-card"><div className="dispatcher-card-heading"><span><span className={`runtime-dot ${snapshot.settings.dispatcherEnabled ? 'on' : ''}`} />{snapshot.settings.dispatcherEnabled ? 'Agents in motion' : 'Dispatch paused'}</span><button aria-label={snapshot.settings.dispatcherEnabled ? 'Pause dispatcher' : 'Resume dispatcher'} onClick={() => void toggleDispatcher()} disabled={dispatchBusy}>{snapshot.settings.dispatcherEnabled ? <Pause size={12} /> : <Play size={12} />}</button></div><div className="capacity-meter">{Array.from({ length: snapshot.settings.maxConcurrentAgents }, (_, index) => <i key={index} className={index < snapshot.runtime.activeRuns ? 'filled' : ''} />)}</div><div className="dispatcher-caption"><span>{snapshot.runtime.activeRuns} of {snapshot.settings.maxConcurrentAgents} agents active</span><span>{todo} queued</span></div></div><button className="settings-nav" onClick={() => setSettings(true)}><Settings2 size={15} /><span>Settings</span><span className="local-badge">Local</span></button><div className="sidebar-profile"><span className="profile-avatar">Y</span><span>You<span>Workspace owner</span></span><span className="profile-status" title="Local workspace" /></div></div>
    </aside>
    <main className="workspace-main">
      {!compactPlanningChat && <header inert={!!selected} className="topbar"><Button variant="ghost" size="icon" className="mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><PanelLeft size={17} /></Button><span className="breadcrumb-project">{snapshot.project.name}</span><ChevronRight size={12} /><span>{title}</span><div className="topbar-right">{snapshot.runtime.demo && <span className="demo-badge">Demo workspace</span>}<span className="topbar-sync"><span className={`tiny-dot ${connectionError ? 'offline' : ''}`} />{connectionError ? 'Reconnecting' : 'Saved locally'}</span><button className="topbar-attention" onClick={() => go('attention')} aria-label={`Attention, ${unread} unread`}><Bell size={15} />{unread > 0 && <i />}</button><span className="owner-avatar">Y</span></div></header>}
      {(error || connectionError) && <div className="global-error" role="alert"><AlertCircle size={15} /><span>{error || `Connection interrupted. ${connectionError}`}</span>{error && <button aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></button>}</div>}
      {!compactPlanningChat && <div inert={!!selected} className="page-heading"><div><div className="page-heading-eyebrow"><span className="project-icon">{snapshot.project.name.slice(0, 1).toUpperCase()}</span>{snapshot.project.name}<span className="eyebrow-divider">/</span>Workspace</div><h1>{title}{view === 'attention' && unread > 0 && <span className="title-count">{unread}</span>}</h1><p>{view === 'tasks' ? 'A clear path from idea to verified work.' : view === 'attention' ? 'The decisions that keep your work moving.' : 'A thoughtful partner for everything you’re building.'}</p></div><div className="page-actions">{view === 'tasks' && <div className="layout-toggle" aria-label="Task layout"><button aria-label="List view" aria-pressed={layout === 'list'} className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')}><List size={15} /></button><button aria-label="Board view" aria-pressed={layout === 'board'} className={layout === 'board' ? 'active' : ''} onClick={() => setLayout('board')}><LayoutGrid size={14} /></button></div>}<Button onClick={() => void openCreate()} disabled={creatingChat}><Plus size={15} />New task</Button></div></div>}
      {!snapshot.project.repositoryPath && <div inert={!!selected} className="setup-banner"><span className="setup-banner-icon"><Folder size={18} /></span><div><strong>Connect your repository</strong><p>Choose a local Git repository so your agents know where to work.</p></div><Button variant="secondary" size="sm" onClick={() => setSettings(true)}>Choose repository<ArrowUpRight size={13} /></Button></div>}
      {view === 'tasks' && <div inert={!!selected} className="workspace-stats"><div><span className="stat-icon active"><CircleDot size={15} /></span><span>In progress</span><strong>{running}</strong></div><button onClick={() => go('attention')}><span className="stat-icon review"><FileReviewIcon /></span><span>Awaiting review</span><strong>{reviews}</strong>{reviews > 0 && <ArrowUpRight size={13} />}</button><div><span className="stat-icon queued"><ArrowDownToLine size={15} /></span><span>In queue</span><strong>{todo}</strong></div><div><span className="stat-icon done"><Check size={15} /></span><span>Completed</span><strong>{done}</strong></div></div>}
      <div inert={!!selected} className={`page-content page-${view}`}>{view === 'tasks' ? <TaskList snapshot={snapshot} layout={layout} onSelect={selectTask} selectedId={selectedId || undefined} onCreate={() => void openCreate()} /> : view === 'attention' ? <AttentionView snapshot={snapshot} onSelect={selectTask} onRead={readAttention} /> : view === 'chief' ? <ChiefView snapshot={snapshot} onRefresh={() => void refresh()} onSelect={selectTask} /> : chatId ? <PlanningChatView key={chatId} chatId={chatId} snapshot={snapshot} onOpenNavigation={() => setSidebarOpen(true)} onNewChat={openCreate} creatingChat={creatingChat} onClose={closePlanningChat} onTaskified={task => navigate('tasks', task.id)} /> : null}</div>
      {selected && <TaskDetail key={selected.id} task={selected} snapshot={snapshot} onClose={closeTask} backLabel={title} onRefresh={() => void refresh()} onSelect={selectTask} onSubtask={task => { setParent(task); setNewTask(true); }} />}
    </main>
    {newTask && <TaskDialog key={parent?.id || 'new'} open={newTask} onOpenChange={setNewTask} snapshot={snapshot} parent={parent} onCreated={task => { void refresh(); navigate('tasks', task.id); }} />}
    {settings && <SettingsDialog open={settings} onOpenChange={setSettings} snapshot={snapshot} onSaved={() => void refresh()} />}
  </div>;
}
function FileReviewIcon() { return <Command size={14} />; }
