import { useState } from 'react';
import { Archive, ArchiveRestore, Bell, CheckCircle2, Circle, FolderGit2, Terminal } from 'lucide-react';
import type { AppSnapshot, Workspace, Provider } from '../../shared/types';
import { api } from '../lib/api';
import { notificationPreferences, playChime, requestSystemNotifications, saveNotificationPreferences, systemNotificationSupport } from '../lib/notifications';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export function SettingsDialog({ snapshot, open, onOpenChange, onSaved, onArchived }: {
  snapshot: AppSnapshot; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void;
  /** The current workspace was archived; the app chooses another workspace or shows the empty workspace. */
  onArchived: () => void;
}) {
  const [name, setName] = useState(snapshot.workspace.name);
  const [repository, setRepository] = useState(snapshot.workspace.repositoryPath);
  const [identifier, setIdentifier] = useState(snapshot.workspace.identifier);
  const [limit, setLimit] = useState(snapshot.settings.maxConcurrentAgents);
  const [provider, setProvider] = useState<Provider>(snapshot.settings.defaultProvider);
  const [enabled, setEnabled] = useState(snapshot.settings.dispatcherEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [notifications, setNotifications] = useState(notificationPreferences);
  const [systemSupport, setSystemSupport] = useState(systemNotificationSupport);
  function updateNotifications(next: typeof notifications) { setNotifications(next); saveNotificationPreferences(next); }
  async function toggleSystemNotifications(enabled: boolean) {
    if (!enabled) { updateNotifications({ ...notifications, system: false }); return; }
    const granted = await requestSystemNotifications();
    setSystemSupport(systemNotificationSupport());
    updateNotifications({ ...notifications, system: granted });
  }
  const archived = (snapshot.workspaces ?? []).filter(workspace => workspace.archivedAt);
  const agentsRunning = snapshot.runtime.activeRuns > 0 || snapshot.runtime.chiefRunning;
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api(`/workspaces/${encodeURIComponent(snapshot.workspace.id)}`, 'PATCH', { name: name.trim(), repositoryPath: repository.trim(), ...(identifier.trim().toUpperCase() !== snapshot.workspace.identifier ? { identifier: identifier.trim().toUpperCase() } : {}) });
      await api('/settings', 'PATCH', { maxConcurrentAgents: limit, defaultProvider: provider, dispatcherEnabled: enabled });
      onSaved(); onOpenChange(false);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }
  async function archive() {
    setBusy(true); setError(null);
    try { await api(`/workspaces/${encodeURIComponent(snapshot.workspace.id)}/archive`, 'POST', {}); onOpenChange(false); onArchived(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not archive this workspace.'); setConfirmArchive(false); }
    finally { setBusy(false); }
  }
  async function restore(workspace: Workspace) {
    setBusy(true); setError(null);
    try { await api(`/workspaces/${encodeURIComponent(workspace.id)}/restore`, 'POST', {}); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this workspace.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Workspace settings" description={`${snapshot.workspace.name} · Its repository, agents, and approvals in one place.`}>
    <form onSubmit={save} className="settings-form">
      <div className="settings-section-label"><FolderGit2 size={14} />Workspace</div>
      <label>Workspace name<input value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></label>
      <label>Repository path<input value={repository} onChange={e => setRepository(e.target.value)} placeholder="/Users/you/workspaces/your-repository" /><span className="field-hint">Each coding task works in its own Git worktree.</span></label>
      <label>Task prefix<input value={identifier} onChange={e => setIdentifier(e.target.value.toUpperCase())} required maxLength={5} pattern="[A-Za-z][A-Za-z0-9]{1,4}" title="2 to 5 letters or digits, starting with a letter" /><span className="field-hint">Task identifiers look like {identifier.trim().toUpperCase() || snapshot.workspace.identifier}-12. Changing the prefix renames every existing task in this workspace.</span></label>
      <div className="settings-section-label"><Terminal size={14} />Agent runtime</div>
      <div className="provider-statuses">{(['claude', 'codex'] as const).map(id => {
        const config = snapshot.runtime.config?.[id] ?? (id === 'claude' ? { model: 'claude-fable-5-1[1m]', thinking: 'max' } : { model: 'gpt-6-astra', thinking: 'ultra' });
        return <div key={id}>{snapshot.runtime.providers[id] ? <CheckCircle2 size={14} className="text-success" /> : <Circle size={14} />}<span className="provider-name">{id === 'claude' ? 'Claude Code' : 'Codex'}</span><small>{snapshot.runtime.providers[id] ? 'Installed' : 'Not detected'}</small><span className="provider-config"><code>{config.model}</code><span>Thinking: {config.thinking}</span></span></div>;
      })}</div>
      <p className="provider-setup-hint">Muon uses your installed Claude Code and a workspace-managed Codex CLI. Both use your existing agent sign-ins. Open Claude Code once to sign in; for Codex, use pnpm exec codex login from the Muon folder. Installed means the executable was detected; sign-in or execution failures appear on the task with recovery actions.</p>
      <div className="form-grid"><label>Default agent<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>Concurrent agents<select value={limit} onChange={e => setLimit(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} {i === 0 ? 'agent' : 'agents'}</option>)}</select></label></div>
      <label className="switch-row"><span><strong>Automatic dispatch</strong><small>Start ready Todo tasks as capacity opens up. Limits and dispatch apply to this workspace only.</small></span><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} role="switch" /></label>
      <div className="settings-section-label"><Bell size={14} />Notifications in this browser</div>
      <label className="switch-row"><span><strong>Sound</strong><small>A short chime when a task finishes, needs your review or help, or an agent replies. <button type="button" className="inline-link" onClick={() => playChime()}>Play it</button></small></span><input type="checkbox" checked={notifications.sound} onChange={event => updateNotifications({ ...notifications, sound: event.target.checked })} role="switch" /></label>
      <label className="switch-row"><span><strong>System notifications</strong><small>{systemSupport === 'unsupported' ? 'This browser does not support system notifications.' : systemSupport === 'denied' ? 'Blocked by the browser. Allow notifications for this site in the browser settings to enable them.' : 'Shown by your operating system while this tab is in the background, and opens the task when clicked.'}</small></span><input type="checkbox" checked={notifications.system && systemSupport === 'granted'} disabled={systemSupport === 'unsupported' || systemSupport === 'denied'} onChange={event => void toggleSystemNotifications(event.target.checked)} role="switch" /></label>
      <div className="settings-section-label"><Archive size={14} />Archive</div>
      <div className="archive-workspace">
        <div><strong>Archive this workspace</strong><small>{agentsRunning ? 'Wait for active agents and the chief to finish first.' : 'Stops its dispatcher and hides it from the workspace list. Tasks, files, and worktrees stay; open planning chats are discarded. You can restore it any time.'}</small></div>
        {confirmArchive ? <span className="archive-confirm"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmArchive(false)}>Keep</Button><Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => void archive()}>{busy ? 'Archiving…' : 'Archive workspace'}</Button></span>
          : <Button type="button" size="sm" variant="secondary" disabled={busy || agentsRunning} onClick={() => setConfirmArchive(true)}><Archive size={14} />Archive</Button>}
      </div>
      {archived.length > 0 && <div className="archived-workspaces" aria-label="Archived workspaces"><span>Archived workspaces</span>{archived.map(workspace => <div key={workspace.id}><span className="workspace-icon">{workspace.name.slice(0, 1).toUpperCase()}</span><span><strong>{workspace.name}</strong><small>{workspace.repositoryPath}</small></span><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void restore(workspace)}><ArchiveRestore size={14} />Restore</Button></div>)}</div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span>Changes apply to this workspace</span><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save changes'}</Button></div>
    </form>
  </Dialog>;
}
