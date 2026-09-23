import { useState } from 'react';
import { Archive, ArchiveRestore, CheckCircle2, Circle, FolderGit2, Terminal } from 'lucide-react';
import type { AppSnapshot, Project, Provider } from '../../shared/types';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export function SettingsDialog({ snapshot, open, onOpenChange, onSaved, onArchived }: {
  snapshot: AppSnapshot; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void;
  /** The current project was archived; the app chooses another project or shows the empty workspace. */
  onArchived: () => void;
}) {
  const [name, setName] = useState(snapshot.project.name);
  const [repository, setRepository] = useState(snapshot.project.repositoryPath);
  const [limit, setLimit] = useState(snapshot.settings.maxConcurrentAgents);
  const [provider, setProvider] = useState<Provider>(snapshot.settings.defaultProvider);
  const [enabled, setEnabled] = useState(snapshot.settings.dispatcherEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = (snapshot.projects ?? []).filter(project => project.archivedAt);
  const agentsRunning = snapshot.runtime.activeRuns > 0 || snapshot.runtime.chiefRunning;
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api(`/projects/${encodeURIComponent(snapshot.project.id)}`, 'PATCH', { name: name.trim(), repositoryPath: repository.trim() });
      await api('/settings', 'PATCH', { maxConcurrentAgents: limit, defaultProvider: provider, dispatcherEnabled: enabled });
      onSaved(); onOpenChange(false);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }
  async function archive() {
    setBusy(true); setError(null);
    try { await api(`/projects/${encodeURIComponent(snapshot.project.id)}/archive`, 'POST', {}); onOpenChange(false); onArchived(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not archive this project.'); setConfirmArchive(false); }
    finally { setBusy(false); }
  }
  async function restore(project: Project) {
    setBusy(true); setError(null);
    try { await api(`/projects/${encodeURIComponent(project.id)}/restore`, 'POST', {}); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this project.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Project settings" description={`${snapshot.project.name} · Its repository, agents, and approvals in one place.`}>
    <form onSubmit={save} className="settings-form">
      <div className="settings-section-label"><FolderGit2 size={14} />Project</div>
      <label>Project name<input value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></label>
      <label>Repository path<input value={repository} onChange={e => setRepository(e.target.value)} placeholder="/Users/you/projects/your-repository" /><span className="field-hint">Each coding task works in its own Git worktree. Task identifiers use the {snapshot.project.identifier} prefix.</span></label>
      <div className="settings-section-label"><Terminal size={14} />Agent runtime</div>
      <div className="provider-statuses">{(['claude', 'codex'] as const).map(id => {
        const config = snapshot.runtime.config?.[id] ?? (id === 'claude' ? { model: 'claude-fable-5-1[1m]', thinking: 'max' } : { model: 'gpt-6-astra', thinking: 'ultra' });
        return <div key={id}>{snapshot.runtime.providers[id] ? <CheckCircle2 size={14} className="text-success" /> : <Circle size={14} />}<span className="provider-name">{id === 'claude' ? 'Claude Code' : 'Codex'}</span><small>{snapshot.runtime.providers[id] ? 'Installed' : 'Not detected'}</small><span className="provider-config"><code>{config.model}</code><span>Thinking: {config.thinking}</span></span></div>;
      })}</div>
      <p className="provider-setup-hint">Muon uses your installed Claude Code and a project-managed Codex CLI. Both use your existing agent sign-ins. Open Claude Code once to sign in; for Codex, use pnpm exec codex login from the Muon folder. Installed means the executable was detected; sign-in or execution failures appear on the task with recovery actions.</p>
      <div className="form-grid"><label>Default agent<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>Concurrent agents<select value={limit} onChange={e => setLimit(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} {i === 0 ? 'agent' : 'agents'}</option>)}</select></label></div>
      <label className="switch-row"><span><strong>Automatic dispatch</strong><small>Start ready Todo tasks as capacity opens up. Limits and dispatch apply to this project only.</small></span><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} role="switch" /></label>
      <div className="settings-section-label"><Archive size={14} />Archive</div>
      <div className="archive-project">
        <div><strong>Archive this project</strong><small>{agentsRunning ? 'Wait for active agents and the chief to finish first.' : 'Stops its dispatcher and hides it from the project list. Tasks, files, and worktrees stay; open planning chats are discarded. You can restore it any time.'}</small></div>
        {confirmArchive ? <span className="archive-confirm"><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmArchive(false)}>Keep</Button><Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => void archive()}>{busy ? 'Archiving…' : 'Archive project'}</Button></span>
          : <Button type="button" size="sm" variant="secondary" disabled={busy || agentsRunning} onClick={() => setConfirmArchive(true)}><Archive size={14} />Archive</Button>}
      </div>
      {archived.length > 0 && <div className="archived-projects" aria-label="Archived projects"><span>Archived projects</span>{archived.map(project => <div key={project.id}><span className="project-icon">{project.name.slice(0, 1).toUpperCase()}</span><span><strong>{project.name}</strong><small>{project.repositoryPath}</small></span><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void restore(project)}><ArchiveRestore size={14} />Restore</Button></div>)}</div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span>Changes apply to this project</span><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save changes'}</Button></div>
    </form>
  </Dialog>;
}
