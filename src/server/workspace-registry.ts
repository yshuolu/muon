import { randomUUID } from 'node:crypto';
import type { AgentAdapter, WorktreeProvider } from '../runtime';
import type { CreateWorkspaceRequest } from '../shared/api-contract';
import type { Workspace, Provider, Scope, Settings } from '../shared/types';
import { DomainError, type Repository } from './ports';
import type { TaskService } from './task-service';

/** What the HTTP layer needs to address workspaces; the registry is the shipped implementation. */
export interface WorkspaceResolver {
  list(): Promise<Workspace[]>;
  /** Active workspace by ID or identifier; archived and unknown workspaces are not found. */
  resolve(reference: string | undefined): TaskService;
  /** Workspace record by ID or identifier, including archived workspaces. */
  workspace(reference: string): Promise<Workspace>;
  create(input: CreateWorkspaceRequest): Promise<Workspace>;
  /** Changes a workspace's task prefix and renames its existing task identifiers. */
  renameIdentifier(reference: string, identifier: string): Promise<Workspace>;
  archive(reference: string): Promise<Workspace>;
  restore(reference: string): Promise<Workspace>;
}

interface RegistryOptions {
  scope: { accountId: string; userId: string };
  repository: Repository;
  worktrees: WorktreeProvider;
  adapters: Record<Provider, AgentAdapter>;
  createService: (scope: Scope, providerAvailability: Record<Provider, boolean>) => TaskService;
  defaultSettings: Settings;
  /** Seeds the first workspace when the workspace has none, preserving the single-workspace installation. */
  seed?: { name: string; identifier: string; repositoryPath: string };
}

const IDENTIFIER = /^[A-Z][A-Z0-9]{1,4}$/;

/** Short, readable, unique task prefixes: word initials for multi-word names, else the first letters. */
export function deriveIdentifier(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(value => value.toUpperCase()));
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).map(word => word.replace(/^[^A-Z]+/, '')).filter(Boolean);
  const initials = words.map(word => word[0]).join('');
  const joined = words.join('');
  const base = (words.length > 1 && initials.length >= 2 ? initials : joined).slice(0, 5);
  const root = IDENTIFIER.test(base) ? base : 'PRJ';
  if (!used.has(root)) return root;
  for (let attempt = 2; ; attempt++) {
    const suffix = String(attempt);
    const candidate = `${root.slice(0, Math.max(1, 5 - suffix.length))}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Runs one coordinator per active workspace on top of the shared repository, storage, and adapters. */
export class WorkspaceRegistry implements WorkspaceResolver {
  private services = new Map<string, TaskService>();
  private records = new Map<string, Workspace>();
  private order: string[] = [];
  private availability: Record<Provider, boolean> = { claude: false, codex: false };
  private mutating: Promise<unknown> = Promise.resolve();
  constructor(private options: RegistryOptions) {}

  private scopeFor(workspaceId: string): Scope {
    return { accountId: this.options.scope.accountId, workspaceId, userId: this.options.scope.userId };
  }

  /** Serializes create/archive/restore so identifier checks and service lifecycles never interleave. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutating.then(work, work);
    this.mutating = run.catch(() => undefined);
    return run;
  }

  private async launch(workspace: Workspace) {
    const service = this.options.createService(this.scopeFor(workspace.id), this.availability);
    await service.initialize();
    this.services.set(workspace.id, service);
    service.start();
    return service;
  }

  async load() {
    const results = await Promise.allSettled([this.options.adapters.claude.available(), this.options.adapters.codex.available()]);
    this.availability = { claude: results[0].status === 'fulfilled' && results[0].value, codex: results[1].status === 'fulfilled' && results[1].value };
    let workspaces = await this.options.repository.workspaces(this.options.scope.accountId);
    if (!workspaces.length && this.options.seed) {
      // The value predates the rename and is stored in every existing installation's rows and storage paths.
      const id = 'local-project';
      await this.options.repository.initialize(this.scopeFor(id), { id, accountId: this.options.scope.accountId, ownerUserId: this.options.scope.userId, createdAt: new Date().toISOString(), ...this.options.seed }, this.options.defaultSettings);
      workspaces = await this.options.repository.workspaces(this.options.scope.accountId);
    }
    for (const workspace of workspaces) {
      this.records.set(workspace.id, workspace);
      this.order.push(workspace.id);
    }
    for (const workspace of workspaces) {
      if (!workspace.archivedAt) await this.launch(workspace);
    }
  }

  async list() {
    const workspaces = await this.options.repository.workspaces(this.options.scope.accountId);
    for (const workspace of workspaces) this.records.set(workspace.id, workspace);
    return workspaces;
  }

  private lookup(reference: string): Workspace | undefined {
    const direct = this.records.get(reference);
    if (direct) return direct;
    const lowered = reference.toLowerCase();
    return [...this.records.values()].find(workspace => workspace.identifier.toLowerCase() === lowered);
  }

  defaultId(): string | undefined {
    return this.order.find(id => this.services.has(id));
  }

  /** Canonical workspace ID for an ID or identifier reference, if the workspace exists. */
  workspaceIdFor(reference: string): string | undefined {
    return this.lookup(reference)?.id;
  }

  resolve(reference: string | undefined): TaskService {
    const id = reference === undefined ? this.defaultId() : this.lookup(reference)?.id;
    if (reference === undefined && id === undefined) throw new DomainError('No active workspace. Create or restore a workspace first.', 404);
    const service = id ? this.services.get(id) : undefined;
    if (service) return service;
    if (id && this.records.get(id)?.archivedAt) throw new DomainError('Workspace is archived. Restore it to continue.', 404);
    throw new DomainError('Workspace not found.', 404);
  }

  async workspace(reference: string) {
    await this.list();
    const workspace = this.lookup(reference);
    if (!workspace) throw new DomainError('Workspace not found.', 404);
    return workspace;
  }

  create(input: CreateWorkspaceRequest) {
    return this.exclusive(async () => {
      const name = input.name.trim();
      const repositoryPath = input.repositoryPath.trim();
      if (!name) throw new DomainError('Give the workspace a name.');
      if (!repositoryPath) throw new DomainError('Choose the absolute path of a Git repository root.');
      if (input.initializeRepository) {
        if (!this.options.worktrees.initializeRepository) throw new DomainError('This workspace provider cannot initialize repositories.');
        try { await this.options.worktrees.initializeRepository(repositoryPath); }
        catch (error) { throw new DomainError(`Could not initialize a Git repository in this folder. ${error instanceof Error ? error.message : ''}`.trim()); }
      }
      try { await this.options.worktrees.validateRepository?.(repositoryPath); }
      catch (error) { throw new DomainError(`Choose a Git repository root with at least one commit, or let Muon initialize one in this folder. ${error instanceof Error ? error.message : ''}`.trim()); }
      const taken = (await this.list()).map(workspace => workspace.identifier);
      const identifier = input.identifier?.trim().toUpperCase() || deriveIdentifier(name, taken);
      if (!IDENTIFIER.test(identifier)) throw new DomainError('Identifiers are 2 to 5 letters or digits, starting with a letter.');
      if (taken.some(value => value.toUpperCase() === identifier)) throw new DomainError(`Identifier ${identifier} is already used by another workspace.`, 409);
      const workspace: Workspace = { id: randomUUID(), accountId: this.options.scope.accountId, ownerUserId: this.options.scope.userId, name, identifier, repositoryPath, createdAt: new Date().toISOString() };
      await this.options.repository.initialize(this.scopeFor(workspace.id), workspace, this.options.defaultSettings);
      this.records.set(workspace.id, workspace);
      this.order.push(workspace.id);
      await this.launch(workspace);
      return workspace;
    });
  }

  renameIdentifier(reference: string, identifier: string) {
    return this.exclusive(async () => {
      const workspace = await this.workspace(reference);
      const next = identifier.trim().toUpperCase();
      if (!IDENTIFIER.test(next)) throw new DomainError('Identifiers are 2 to 5 letters or digits, starting with a letter.');
      const service = this.services.get(workspace.id);
      if (!service) throw new DomainError('Restore the workspace before changing its task prefix.', 409);
      if ([...this.records.values()].some(other => other.id !== workspace.id && other.identifier.toUpperCase() === next)) throw new DomainError(`Identifier ${next} is already used by another workspace.`, 409);
      const renamed = await service.renameIdentifier(next);
      this.records.set(workspace.id, renamed);
      return renamed;
    });
  }

  archive(reference: string) {
    return this.exclusive(async () => {
      const workspace = await this.workspace(reference);
      const service = this.services.get(workspace.id);
      if (!service) throw new DomainError(workspace.archivedAt ? 'Workspace is already archived.' : 'Workspace not found.', workspace.archivedAt ? 409 : 404);
      await service.quiesceForArchive();
      this.services.delete(workspace.id);
      const archived = { ...workspace, archivedAt: new Date().toISOString() };
      await this.options.repository.saveWorkspace(this.scopeFor(workspace.id), archived);
      this.records.set(workspace.id, archived);
      return archived;
    });
  }

  restore(reference: string) {
    return this.exclusive(async () => {
      const workspace = await this.workspace(reference);
      if (!workspace.archivedAt) throw new DomainError('Workspace is not archived.', 409);
      const { archivedAt: _archivedAt, ...restored } = workspace;
      await this.options.repository.saveWorkspace(this.scopeFor(workspace.id), restored);
      this.records.set(workspace.id, restored);
      await this.launch(restored);
      return restored;
    });
  }

  async stopAll() {
    const services = [...this.services.values()];
    this.services.clear();
    await Promise.allSettled(services.map(service => service.stop()));
  }
}

/** Adapts one pre-built service (tests, validation scripts) to the resolver contract. */
export function singleWorkspaceResolver(service: TaskService): WorkspaceResolver {
  const workspace = () => service.snapshot().then(snapshot => snapshot.workspace);
  const matches = async (reference: string) => {
    const current = await workspace();
    if (reference !== current.id && reference.toLowerCase() !== current.identifier.toLowerCase()) throw new DomainError('Workspace not found.', 404);
    return current;
  };
  const unsupported = () => { throw new DomainError('This server runs a single fixed workspace.', 405); };
  return {
    list: async () => [await workspace()],
    resolve: reference => {
      if (reference !== undefined && reference !== service.scope.workspaceId) {
        // Identifier lookups need the record; fixtures address the workspace by ID.
        throw new DomainError('Workspace not found.', 404);
      }
      return service;
    },
    workspace: matches,
    renameIdentifier: async (reference, identifier) => { await matches(reference); return service.renameIdentifier(identifier.trim().toUpperCase()); },
    create: unsupported, archive: unsupported, restore: unsupported,
  };
}
