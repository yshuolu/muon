import { useState } from 'react';
import { CheckCircle2, Circle, FolderGit2, Terminal } from 'lucide-react';
import type { AppSnapshot, Provider } from '../../shared/domain';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export function SettingsDialog({ snapshot, open, onOpenChange, onSaved }: { snapshot: AppSnapshot; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [name, setName] = useState(snapshot.project.name);
  const [repository, setRepository] = useState(snapshot.project.repositoryPath);
  const [limit, setLimit] = useState(snapshot.settings.maxConcurrentAgents);
  const [provider, setProvider] = useState<Provider>(snapshot.settings.defaultProvider);
  const [enabled, setEnabled] = useState(snapshot.settings.dispatcherEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { await api('/settings', 'PATCH', { projectName: name.trim(), repositoryPath: repository.trim(), maxConcurrentAgents: limit, defaultProvider: provider, dispatcherEnabled: enabled }); onSaved(); onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Workspace settings" description="A local workspace. Your repository, agents, and approvals in one place.">
    <form onSubmit={save} className="settings-form">
      <div className="settings-section-label"><FolderGit2 size={14} />Project</div>
      <label>Project name<input value={name} onChange={e => setName(e.target.value)} required maxLength={80} /></label>
      <label>Repository path<input value={repository} onChange={e => setRepository(e.target.value)} placeholder="/Users/you/projects/your-repository" /><span className="field-hint">Each coding task works in its own Git worktree.</span></label>
      <div className="settings-section-label"><Terminal size={14} />Agent runtime</div>
      <div className="provider-statuses">{(['claude', 'codex'] as const).map(id => <div key={id}>{snapshot.runtime.providers[id] ? <CheckCircle2 size={14} className="text-success" /> : <Circle size={14} />}<span>{id === 'claude' ? 'Claude Code' : 'Codex'}</span><small>{snapshot.runtime.providers[id] ? 'Installed' : 'Not detected'}</small></div>)}</div>
      <p className="provider-setup-hint">Muon uses your installed Claude Code and a project-managed Codex CLI. Both use your existing agent sign-ins. Open Claude Code once to sign in; for Codex, use npx codex login from the Muon folder. Installed means the executable was detected; sign-in or execution failures appear on the task with recovery actions.</p>
      <div className="form-grid"><label>Default agent<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>Concurrent agents<select value={limit} onChange={e => setLimit(Number(e.target.value))}>{Array.from({ length: 8 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} {i === 0 ? 'agent' : 'agents'}</option>)}</select></label></div>
      <label className="switch-row"><span><strong>Automatic dispatch</strong><small>Start ready Todo tasks as capacity opens up.</small></span><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} role="switch" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span>Changes apply to this workspace</span><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save changes'}</Button></div>
    </form>
  </Dialog>;
}
