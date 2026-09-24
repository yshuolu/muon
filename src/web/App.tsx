import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArchiveRestore, ArrowDownToLine, ArrowUpRight, Bell, BookOpen, Check, ChevronDown, ChevronRight, CircleDot, Command, Folder, FolderGit2, LayoutGrid, List, Loader2, PanelLeft, Pause, Play, Plus, Settings2, Sparkles, X } from 'lucide-react';
import type { Project, Task } from '../shared/types';
import { ApiError } from '../shared/api-client';
import { api, useWorkspace } from './lib/api';
import { rememberedProjectId } from './lib/project';
import { deliverNotification, snapshotNotifications, unlockAudio } from './lib/notifications';
import { visibleAttention } from './lib/utils';
import { useVisualViewport } from './lib/use-visual-viewport';
import { AttentionView } from './components/attention';
import { ChiefView } from './components/chief';
import { MuonMark } from './components/common';
import { SettingsDialog } from './components/settings-dialog';
import { ProjectDialog } from './components/project-dialog';
import { TaskDetail } from './components/task-detail';
import { TaskDialog } from './components/task-dialog';
import { TaskList } from './components/task-list';
import { PlanningChatView } from './components/planning-chat';
import { LibraryView } from './components/library';
import { Button } from './components/ui/button';

type View = 'tasks' | 'attention' | 'chief' | 'planning-chat' | 'library';
interface Location { projectId: string | null; view: View; taskId: string | null; chatId: string | null; assetId: string | null }
/** `/projects/:project/<view>[/:id]`; paths without a project address the remembered or first active project. */
function locationState(): Location {
  let segments = window.location.pathname.split('/').filter(Boolean);
  let projectId: string | null = null;
  if (segments[0] === 'projects' && segments[1]) { projectId = decodeURIComponent(segments[1]); segments = segments.slice(2); }
  const second = segments[1] ? decodeURIComponent(segments[1]) : null;
  const base = { projectId, taskId: null, chatId: null, assetId: null };
  if (segments[0] === 'attention') return { ...base, view: 'attention' };
  if (segments[0] === 'chief') return { ...base, view: 'chief' };
  if (segments[0] === 'library') return { ...base, view: 'library', assetId: second };
  if (segments[0] === 'planning-chats') return { ...base, view: 'planning-chat', chatId: second };
  if (segments[0] === 'tasks') return { ...base, view: 'tasks', taskId: second };
  return { ...base, view: 'tasks' };
}
/** The second segment after the project names the view's own record: a task, a planning chat, or a library file. */
function pathFor(projectId: string | null, view: View, id?: string | null): string {
  const prefix = projectId ? `/projects/${encodeURIComponent(projectId)}` : '';
  if (view === 'attention') return `${prefix}/attention`;
  if (view === 'chief') return `${prefix}/chief`;
  if (view === 'library') return id ? `${prefix}/library/${encodeURIComponent(id)}` : `${prefix}/library`;
  if (view === 'planning-chat') return id ? `${prefix}/planning-chats/${encodeURIComponent(id)}` : `${prefix}/planning-chats`;
  return id ? `${prefix}/tasks/${encodeURIComponent(id)}` : `${prefix}/tasks`;
}
const activeProjects = (projects: Project[] | null | undefined) => (projects ?? []).filter(project => !project.archivedAt);
export function App() {
  const initialLocation = useRef(locationState());
  const [projectId, setProjectId] = useState<string | null>(initialLocation.current.projectId);
  const { snapshot, projects, projectsResolvedFor, error: connectionError, refresh } = useWorkspace(projectId);
  const [view, setView] = useState<View>(initialLocation.current.view);
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(initialLocation.current.taskId);
  const [chatId, setChatId] = useState<string | null>(initialLocation.current.chatId);
  const [libraryAssetId, setLibraryAssetId] = useState<string | null>(initialLocation.current.assetId);
  const { style: viewportStyle, compact: compactViewport } = useVisualViewport(view === 'chief' || view === 'planning-chat' || selectedId !== null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigate = useCallback((nextView: View, id: string | null = null) => {
    const path = pathFor(projectId, nextView, id);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setView(nextView); setSelectedId(nextView === 'tasks' ? id : null); setChatId(nextView === 'planning-chat' ? id : null); setLibraryAssetId(nextView === 'library' ? id : null);
  }, [projectId]);
  const selectTask = (task: Task) => { if (!selectedId) returnFocus.current = document.activeElement as HTMLElement; navigate('tasks', task.id); };
  const closeTask = useCallback(() => { navigate(view); requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus()); }, [navigate, view]);
  const discardChat = useCallback(() => { if (view === 'planning-chat' && chatId) void api(`/planning-chats/${chatId}`, 'DELETE', {}).catch(() => undefined); }, [chatId, view]);
  const closePlanningChat = useCallback(() => { discardChat(); navigate('tasks'); }, [discardChat, navigate]);
  const [newTask, setNewTask] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [parent, setParent] = useState<Task | undefined>();
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const selected = snapshot?.tasks.find(task => task.id === selectedId);
  const unread = snapshot ? visibleAttention(snapshot).length : 0;
  // Announce new attention records and agent replies by diffing consecutive polls of the same project.
  const previousSnapshot = useRef<typeof snapshot>(null);
  useEffect(() => { unlockAudio(); }, []);
  useEffect(() => {
    const previous = previousSnapshot.current;
    previousSnapshot.current = snapshot;
    if (!snapshot) return;
    for (const notification of snapshotNotifications(previous, snapshot)) {
      deliverNotification(notification, () => {
        if (notification.taskId && notification.kind !== 'chief') navigate('tasks', notification.taskId);
        else if (notification.kind === 'chief') navigate('chief');
        else navigate('attention');
      });
    }
  }, [snapshot, navigate]);
  // Switching projects starts from its task list; the disposable planning chat is discarded first, under the old project.
  const switchProject = useCallback((id: string, replace = false) => {
    discardChat();
    const path = pathFor(id, 'tasks');
    if (window.location.pathname !== path) window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
    setProjectId(id); setView('tasks'); setSelectedId(null); setChatId(null); setLibraryAssetId(null); setSidebarOpen(false); setSettings(false);
  }, [discardChat]);
  useEffect(() => {
    // Only a list fetched under the current project can prove that project is gone.
    if (!projects || projectsResolvedFor !== projectId) return;
    const active = activeProjects(projects);
    const current = projectId ? active.find(project => project.id === projectId || project.identifier.toLowerCase() === projectId.toLowerCase()) : undefined;
    if (current && current.id === projectId) return;
    if (current) {
      // Normalize an identifier URL to the stable project ID while keeping the requested record.
      const location = locationState();
      window.history.replaceState({}, '', pathFor(current.id, location.view, location.taskId ?? location.chatId ?? location.assetId));
      setProjectId(current.id);
      return;
    }
    const fallback = active.find(project => project.id === rememberedProjectId()) ?? active[0];
    if (!fallback) { if (projectId) { setProjectId(null); window.history.replaceState({}, '', '/'); } return; }
    const location = locationState();
    // A path without a project keeps its view and record (old bookmarks); an archived project's records are left behind.
    const legacy = location.projectId === null;
    const nextView = legacy || location.view !== 'planning-chat' ? location.view : 'tasks';
    const record = legacy ? location.taskId ?? location.chatId ?? location.assetId : null;
    window.history.replaceState({}, '', pathFor(fallback.id, nextView, record));
    setProjectId(fallback.id); setView(nextView); setSelectedId(nextView === 'tasks' ? record : null); setChatId(nextView === 'planning-chat' ? record : null); setLibraryAssetId(nextView === 'library' ? record : null);
  }, [projects, projectsResolvedFor, projectId]);
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
    const handlePopState = () => { const next = locationState(); setProjectId(next.projectId); setView(next.view); setSelectedId(next.taskId); setChatId(next.chatId); setLibraryAssetId(next.assetId); setSidebarOpen(false); };
    window.addEventListener('popstate', handlePopState); return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'c') { event.preventDefault(); void openCreate(); }
      if (event.key === '/') { event.preventDefault(); document.querySelector<HTMLInputElement>('[aria-label="Search tasks"], [aria-label="Search library"]')?.focus(); }
      if (event.key === 'Escape') view === 'planning-chat' ? closePlanningChat() : closeTask();
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [closePlanningChat, closeTask, openCreate, view]);
  const go = (next: View) => { discardChat(); navigate(next); setSidebarOpen(false); };
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
  async function restoreProject(project: Project) {
    setRestoring(project.id); setError(null);
    try { await api(`/projects/${encodeURIComponent(project.id)}/restore`, 'POST', {}); switchProject(project.id, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this project.'); }
    finally { setRestoring(null); }
  }
  if (!snapshot) {
    const known = projects ? activeProjects(projects) : null;
    const archived = (projects ?? []).filter(project => project.archivedAt);
    const empty = known !== null && known.length === 0 && !connectionError;
    return <div className="startup-screen"><MuonMark />
      {connectionError ? <><h1>Let’s get your workspace connected</h1><p>{connectionError}</p><span>Make sure the local Muon server is running.</span><Button variant="secondary" onClick={() => void refresh()}>Try again</Button></>
        : empty ? <><h1>Add your first project</h1><p>Choose a Git repository folder. Each project keeps its own tasks, agents, chief of staff, and library.</p>{error && <p className="form-error" role="alert">{error}</p>}<Button onClick={() => setNewProject(true)}><Plus size={15} />Add project</Button>{archived.length > 0 && <div className="startup-archived"><span>Archived projects</span>{archived.map(project => <button key={project.id} disabled={restoring !== null} onClick={() => void restoreProject(project)}><ArchiveRestore size={14} />{restoring === project.id ? 'Restoring…' : `Restore ${project.name}`}</button>)}</div>}</>
        : <><h1>Opening your workspace</h1><Loader2 size={18} className="spin" /></>}
      {newProject && <ProjectDialog open={newProject} onOpenChange={setNewProject} onCreated={project => switchProject(project.id, true)} />}
    </div>;
  }
  const running = snapshot.tasks.filter(task => task.status === 'in_progress' && task.kind !== 'group').length;
  const reviews = snapshot.tasks.filter(task => task.status === 'in_review').length;
  const done = snapshot.tasks.filter(task => task.status === 'done').length;
  const todo = snapshot.tasks.filter(task => task.status === 'todo' && task.kind !== 'group').length;
  const title = view === 'tasks' ? 'All tasks' : view === 'attention' ? 'Attention' : view === 'chief' ? 'Chief of staff' : view === 'library' ? 'Library' : 'Planning thread';
  const compactPlanningChat = view === 'planning-chat' && chatId !== null;
  const projectList = activeProjects(snapshot.projects ?? projects);
  return <div className={`app-shell${compactViewport ? ' viewport-compact' : ''}`} style={viewportStyle}>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <button className="workspace-selector" onClick={() => setSettings(true)}><MuonMark /><span>Muon<span>Personal workspace</span></span><ChevronDown size={14} /></button>
      <div className="sidebar-create"><Button variant="secondary" onClick={() => void openCreate()} disabled={creatingChat}><Plus size={15} /><span>Create task</span><kbd>C</kbd></Button></div>
      <nav className="primary-nav" aria-label="Workspace"><button className={view === 'chief' ? 'active' : ''} onClick={() => go('chief')}><Sparkles size={16} /><span>Chief of staff</span>{snapshot.runtime.chiefRunning && <i className="chief-running-dot" />}</button><button className={view === 'attention' ? 'active' : ''} onClick={() => go('attention')}><Bell size={16} /><span>Attention</span>{unread > 0 && <span className="nav-badge">{unread}</span>}</button><button className={view === 'tasks' ? 'active' : ''} onClick={() => go('tasks')}><List size={17} /><span>All tasks</span><span className="nav-count">{snapshot.tasks.length}</span></button><button className={view === 'library' ? 'active' : ''} onClick={() => go('library')}><BookOpen size={16} /><span>Library</span></button></nav>
      <div className="sidebar-section-heading"><span>Projects</span><button aria-label="Add project" title="Add project" onClick={() => setNewProject(true)}><Plus size={13} /></button></div>
      <nav className="project-nav" aria-label="Projects">{projectList.map(project => <Fragment key={project.id}>
        <button className={project.id === snapshot.project.id ? 'active' : ''} aria-current={project.id === snapshot.project.id ? 'true' : undefined} title={project.repositoryPath || 'No repository yet'} onClick={() => project.id === snapshot.project.id ? go('tasks') : switchProject(project.id)}>{project.id === snapshot.project.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span className="project-icon">{project.name.slice(0, 1).toUpperCase()}</span><span>{project.name}</span></button>
        {project.id === snapshot.project.id && <button className="project-child" onClick={() => go('tasks')}><Folder size={14} />Tasks<span>{snapshot.tasks.length}</span></button>}
      </Fragment>)}<button className="project-add" onClick={() => setNewProject(true)}><Plus size={13} />Add project</button></nav>
      <div className="sidebar-bottom"><div className="dispatcher-card"><div className="dispatcher-card-heading"><span><span className={`runtime-dot ${snapshot.settings.dispatcherEnabled ? 'on' : ''}`} />{snapshot.settings.dispatcherEnabled ? 'Agents in motion' : 'Dispatch paused'}</span><button aria-label={snapshot.settings.dispatcherEnabled ? 'Pause dispatcher' : 'Resume dispatcher'} onClick={() => void toggleDispatcher()} disabled={dispatchBusy}>{snapshot.settings.dispatcherEnabled ? <Pause size={12} /> : <Play size={12} />}</button></div><div className="capacity-meter">{Array.from({ length: snapshot.settings.maxConcurrentAgents }, (_, index) => <i key={index} className={index < snapshot.runtime.activeRuns ? 'filled' : ''} />)}</div><div className="dispatcher-caption"><span>{snapshot.runtime.activeRuns} of {snapshot.settings.maxConcurrentAgents} agents active</span><span>{todo} queued</span></div></div><button className="settings-nav" onClick={() => setSettings(true)}><Settings2 size={15} /><span>Settings</span><span className="local-badge">Local</span></button><div className="sidebar-profile"><span className="profile-avatar">Y</span><span>You<span>Workspace owner</span></span><span className="profile-status" title="Local workspace" /></div></div>
    </aside>
    <main className="workspace-main">
      {!compactPlanningChat && <header inert={!!selected} className="topbar"><Button variant="ghost" size="icon" className="mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><PanelLeft size={17} /></Button><span className="breadcrumb-project">{snapshot.project.name}</span><ChevronRight size={12} /><span>{title}</span><div className="topbar-right">{snapshot.runtime.demo && <span className="demo-badge">Demo workspace</span>}<span className="topbar-sync"><span className={`tiny-dot ${connectionError ? 'offline' : ''}`} />{connectionError ? 'Reconnecting' : 'Saved locally'}</span><button className="topbar-attention" onClick={() => go('attention')} aria-label={`Attention, ${unread} unread`}><Bell size={15} />{unread > 0 && <i />}</button><span className="owner-avatar">Y</span></div></header>}
      {(error || connectionError) && <div className="global-error" role="alert"><AlertCircle size={15} /><span>{error || `Connection interrupted. ${connectionError}`}</span>{error && <button aria-label="Dismiss error" onClick={() => setError(null)}><X size={14} /></button>}</div>}
      {!compactPlanningChat && <div inert={!!selected} className="page-heading"><div><div className="page-heading-eyebrow"><span className="project-icon">{snapshot.project.name.slice(0, 1).toUpperCase()}</span>{snapshot.project.name}<span className="eyebrow-divider">/</span>{snapshot.project.identifier}</div><h1>{title}{view === 'attention' && unread > 0 && <span className="title-count">{unread}</span>}</h1><p>{view === 'tasks' ? 'A clear path from idea to verified work.' : view === 'attention' ? 'The decisions that keep your work moving.' : view === 'library' ? 'Documentation, reference notes, and every retained file in one place.' : 'A thoughtful partner for everything you’re building.'}</p></div><div className="page-actions">{view === 'tasks' && <div className="layout-toggle" aria-label="Task layout"><button aria-label="List view" aria-pressed={layout === 'list'} className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')}><List size={15} /></button><button aria-label="Board view" aria-pressed={layout === 'board'} className={layout === 'board' ? 'active' : ''} onClick={() => setLayout('board')}><LayoutGrid size={14} /></button></div>}{view !== 'library' && <Button onClick={() => void openCreate()} disabled={creatingChat}><Plus size={15} />New task</Button>}</div></div>}
      {!snapshot.project.repositoryPath && <div inert={!!selected} className="setup-banner"><span className="setup-banner-icon"><FolderGit2 size={18} /></span><div><strong>Connect your repository</strong><p>Choose a local Git repository so your agents know where to work.</p></div><Button variant="secondary" size="sm" onClick={() => setSettings(true)}>Choose repository<ArrowUpRight size={13} /></Button></div>}
      {view === 'tasks' && <div inert={!!selected} className="workspace-stats"><div><span className="stat-icon active"><CircleDot size={15} /></span><span>In progress</span><strong>{running}</strong></div><button onClick={() => go('attention')}><span className="stat-icon review"><FileReviewIcon /></span><span>Awaiting review</span><strong>{reviews}</strong>{reviews > 0 && <ArrowUpRight size={13} />}</button><div><span className="stat-icon queued"><ArrowDownToLine size={15} /></span><span>In queue</span><strong>{todo}</strong></div><div><span className="stat-icon done"><Check size={15} /></span><span>Completed</span><strong>{done}</strong></div></div>}
      <div inert={!!selected} className={`page-content page-${view}`}>{view === 'tasks' ? <TaskList snapshot={snapshot} layout={layout} onSelect={selectTask} selectedId={selectedId || undefined} onCreate={() => void openCreate()} /> : view === 'attention' ? <AttentionView snapshot={snapshot} onSelect={selectTask} onRead={readAttention} /> : view === 'chief' ? <ChiefView snapshot={snapshot} onRefresh={() => void refresh()} onSelect={selectTask} /> : view === 'library' ? <LibraryView key={snapshot.project.id} snapshot={snapshot} selectedId={libraryAssetId} onSelect={assetId => navigate('library', assetId)} onOpenTask={selectTask} /> : chatId ? <PlanningChatView key={chatId} chatId={chatId} snapshot={snapshot} onOpenNavigation={() => setSidebarOpen(true)} onNewChat={openCreate} creatingChat={creatingChat} onClose={closePlanningChat} onTaskified={task => navigate('tasks', task.id)} /> : null}</div>
      {selected && <TaskDetail key={selected.id} task={selected} snapshot={snapshot} onClose={closeTask} backLabel={title} onRefresh={() => void refresh()} onSelect={selectTask} onSubtask={task => { setParent(task); setNewTask(true); }} onOpenLibrary={assetId => navigate('library', assetId)} />}
    </main>
    {newTask && <TaskDialog key={parent?.id || 'new'} open={newTask} onOpenChange={setNewTask} snapshot={snapshot} parent={parent} onCreated={task => { void refresh(); navigate('tasks', task.id); }} />}
    {newProject && <ProjectDialog open={newProject} onOpenChange={setNewProject} onCreated={project => switchProject(project.id)} />}
    {settings && <SettingsDialog key={snapshot.project.id} open={settings} onOpenChange={setSettings} snapshot={snapshot} onSaved={() => void refresh()} onArchived={() => { setProjectId(null); window.history.replaceState({}, '', '/'); }} />}
  </div>;
}
function FileReviewIcon() { return <Command size={14} />; }
