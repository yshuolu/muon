import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Settings2 } from 'lucide-react';
import type { Workspace } from '../../shared/types';
import { MuonMark } from './common';

/**
 * The sidebar header names the current workspace and opens a menu to switch to another one, add one, or open its
 * settings. Kept as a plain popover so the sidebar has no dependency beyond the button it replaces.
 */
export function WorkspaceSwitcher({ current, workspaces, onSwitch, onAdd, onSettings }: {
  current: Workspace; workspaces: Workspace[]; onSwitch: (id: string) => void; onAdd: () => void; onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items: Array<{ key: string; label: string; run: () => void }> = [
    ...workspaces.map(workspace => ({ key: workspace.id, label: workspace.name, run: () => { if (workspace.id !== current.id) onSwitch(workspace.id); } })),
    { key: 'add', label: 'Add workspace', run: onAdd },
    { key: 'settings', label: 'Workspace settings', run: onSettings },
  ];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { if (open) setIndex(Math.max(0, workspaces.findIndex(workspace => workspace.id === current.id))); }, [open, workspaces, current.id]);
  const choose = (item: { run: () => void }) => { setOpen(false); item.run(); };
  return <div className="workspace-switcher" ref={root} onKeyDown={event => {
    if (!open) { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } return; }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(items[index]); }
  }}>
    <button className="account-selector" aria-haspopup="menu" aria-expanded={open} aria-label={`Workspace: ${current.name}`} title={current.repositoryPath || 'No repository yet'} onClick={() => setOpen(value => !value)}>
      <span className="workspace-icon">{current.name.slice(0, 1).toUpperCase()}</span>
      <span>{current.name}<span>Muon · {current.identifier}</span></span>
      <ChevronDown size={14} />
    </button>
    {open && <div className="workspace-menu" role="menu" aria-label="Workspaces">
      <div className="workspace-menu-heading">Workspaces</div>
      {workspaces.map((workspace, position) => <button key={workspace.id} role="menuitemradio" aria-checked={workspace.id === current.id} className={position === index ? 'active' : ''} title={workspace.repositoryPath || 'No repository yet'} onMouseEnter={() => setIndex(position)} onClick={() => choose(items[position])}>
        <span className="workspace-icon">{workspace.name.slice(0, 1).toUpperCase()}</span><span className="workspace-menu-name">{workspace.name}<small>{workspace.identifier}</small></span>{workspace.id === current.id && <Check size={14} />}
      </button>)}
      <div className="workspace-menu-divider" />
      <button role="menuitem" className={index === workspaces.length ? 'active' : ''} onMouseEnter={() => setIndex(workspaces.length)} onClick={() => choose(items[workspaces.length])}><Plus size={14} /><span className="workspace-menu-name">Add workspace</span></button>
      <button role="menuitem" className={index === workspaces.length + 1 ? 'active' : ''} onMouseEnter={() => setIndex(workspaces.length + 1)} onClick={() => choose(items[workspaces.length + 1])}><Settings2 size={14} /><span className="workspace-menu-name">Workspace settings</span></button>
      <div className="workspace-menu-footer"><MuonMark small />Muon · Local</div>
    </div>}
  </div>;
}
