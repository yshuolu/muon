import { useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import type { Workspace } from '../../shared/types';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export function WorkspaceDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (workspace: Workspace) => void }) {
  const [name, setName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [initializeRepository, setInitializeRepository] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const workspace = await api<Workspace>('/workspaces', 'POST', { name: name.trim(), repositoryPath: repositoryPath.trim(), ...(identifier.trim() ? { identifier: identifier.trim().toUpperCase() } : {}), ...(initializeRepository ? { initializeRepository: true } : {}) });
      onOpenChange(false);
      onCreated(workspace);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add this workspace.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Add workspace" description="Point Muon at a workspace folder. Each workspace keeps its own tasks, agents, chief of staff, settings, and library.">
    <form className="workspace-form" onSubmit={submit}>
      <div className="settings-section-label"><FolderGit2 size={14} />Repository</div>
      <label>Workspace name<input value={name} onChange={event => setName(event.target.value)} placeholder="Billing service" required maxLength={100} autoFocus /></label>
      <label>Folder path<input value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} placeholder="/Users/you/workspaces/billing" required maxLength={2000} /><span className="field-hint">The absolute path of the workspace folder. Coding tasks work in isolated Git worktrees of this folder, so it must be a Git repository root with at least one commit.</span></label>
      <label className="switch-row workspace-init-row"><span><strong>Initialize Git if this folder isn’t a repository yet</strong><small>Runs git init and records the folder’s current files as an initial commit. Nothing is rewritten in an existing repository; a folder inside another repository is rejected.</small></span><input type="checkbox" checked={initializeRepository} onChange={event => setInitializeRepository(event.target.checked)} role="switch" /></label>
      <label>Task prefix<input value={identifier} onChange={event => setIdentifier(event.target.value.toUpperCase())} placeholder="Derived from the name" maxLength={5} pattern="[A-Za-z][A-Za-z0-9]{1,4}" title="2 to 5 letters or digits, starting with a letter" /><span className="field-hint">Task identifiers look like {identifier.trim() || 'BS'}-12. Leave blank to derive it from the name.</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span>Two workspaces may share one repository</span><Button type="submit" disabled={busy || !name.trim() || !repositoryPath.trim()}>{busy ? 'Adding…' : 'Add workspace'}</Button></div>
    </form>
  </Dialog>;
}
