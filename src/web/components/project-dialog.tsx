import { useState } from 'react';
import { FolderGit2 } from 'lucide-react';
import type { Project } from '../../shared/types';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

export function ProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (project: Project) => void }) {
  const [name, setName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const project = await api<Project>('/projects', 'POST', { name: name.trim(), repositoryPath: repositoryPath.trim(), ...(identifier.trim() ? { identifier: identifier.trim().toUpperCase() } : {}) });
      onOpenChange(false);
      onCreated(project);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add this project.'); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title="Add project" description="Point Muon at a Git repository. Each project keeps its own tasks, agents, chief of staff, settings, and library.">
    <form className="project-form" onSubmit={submit}>
      <div className="settings-section-label"><FolderGit2 size={14} />Repository</div>
      <label>Project name<input value={name} onChange={event => setName(event.target.value)} placeholder="Billing service" required maxLength={100} autoFocus /></label>
      <label>Repository path<input value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} placeholder="/Users/you/projects/billing" required maxLength={2000} /><span className="field-hint">The absolute path of a Git repository root with at least one commit. Coding tasks work in isolated worktrees of this repository.</span></label>
      <label>Task prefix<input value={identifier} onChange={event => setIdentifier(event.target.value.toUpperCase())} placeholder="Derived from the name" maxLength={5} pattern="[A-Za-z][A-Za-z0-9]{1,4}" title="2 to 5 letters or digits, starting with a letter" /><span className="field-hint">Task identifiers look like {identifier.trim() || 'BS'}-12. Leave blank to derive it from the name.</span></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><span>Two projects may share one repository</span><Button type="submit" disabled={busy || !name.trim() || !repositoryPath.trim()}>{busy ? 'Adding…' : 'Add project'}</Button></div>
    </form>
  </Dialog>;
}
