import { randomUUID } from 'node:crypto';
import type { AgentAdapter, WorkspaceProvider } from '../runtime';
import type { CreateProjectRequest } from '../shared/api-contract';
import type { Project, Provider, Scope, Settings } from '../shared/types';
import { DomainError, type Repository } from './ports';
import type { TaskService } from './task-service';

/** What the HTTP layer needs to address projects; the registry is the shipped implementation. */
export interface ProjectResolver {
  list(): Promise<Project[]>;
  /** Active project by ID or identifier; archived and unknown projects are not found. */
  resolve(reference: string | undefined): TaskService;
  /** Project record by ID or identifier, including archived projects. */
  project(reference: string): Promise<Project>;
  create(input: CreateProjectRequest): Promise<Project>;
  archive(reference: string): Promise<Project>;
  restore(reference: string): Promise<Project>;
}

interface RegistryOptions {
  scope: { workspaceId: string; userId: string };
  repository: Repository;
  workspaces: WorkspaceProvider;
  adapters: Record<Provider, AgentAdapter>;
  createService: (scope: Scope, providerAvailability: Record<Provider, boolean>) => TaskService;
  defaultSettings: Settings;
  /** Seeds the first project when the workspace has none, preserving the single-project installation. */
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

/** Runs one coordinator per active project on top of the shared repository, storage, and adapters. */
export class ProjectRegistry implements ProjectResolver {
  private services = new Map<string, TaskService>();
  private records = new Map<string, Project>();
  private order: string[] = [];
  private availability: Record<Provider, boolean> = { claude: false, codex: false };
  private mutating: Promise<unknown> = Promise.resolve();
  constructor(private options: RegistryOptions) {}

  private scopeFor(projectId: string): Scope {
    return { workspaceId: this.options.scope.workspaceId, projectId, userId: this.options.scope.userId };
  }

  /** Serializes create/archive/restore so identifier checks and service lifecycles never interleave. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutating.then(work, work);
    this.mutating = run.catch(() => undefined);
    return run;
  }

  private async launch(project: Project) {
    const service = this.options.createService(this.scopeFor(project.id), this.availability);
    await service.initialize();
    this.services.set(project.id, service);
    service.start();
    return service;
  }

  async load() {
    const results = await Promise.allSettled([this.options.adapters.claude.available(), this.options.adapters.codex.available()]);
    this.availability = { claude: results[0].status === 'fulfilled' && results[0].value, codex: results[1].status === 'fulfilled' && results[1].value };
    let projects = await this.options.repository.projects(this.options.scope.workspaceId);
    if (!projects.length && this.options.seed) {
      const id = 'local-project';
      await this.options.repository.initialize(this.scopeFor(id), { id, workspaceId: this.options.scope.workspaceId, ownerUserId: this.options.scope.userId, createdAt: new Date().toISOString(), ...this.options.seed }, this.options.defaultSettings);
      projects = await this.options.repository.projects(this.options.scope.workspaceId);
    }
    for (const project of projects) {
      this.records.set(project.id, project);
      this.order.push(project.id);
    }
    for (const project of projects) {
      if (!project.archivedAt) await this.launch(project);
    }
  }

  async list() {
    const projects = await this.options.repository.projects(this.options.scope.workspaceId);
    for (const project of projects) this.records.set(project.id, project);
    return projects;
  }

  private lookup(reference: string): Project | undefined {
    const direct = this.records.get(reference);
    if (direct) return direct;
    const lowered = reference.toLowerCase();
    return [...this.records.values()].find(project => project.identifier.toLowerCase() === lowered);
  }

  defaultId(): string | undefined {
    return this.order.find(id => this.services.has(id));
  }

  /** Canonical project ID for an ID or identifier reference, if the project exists. */
  projectIdFor(reference: string): string | undefined {
    return this.lookup(reference)?.id;
  }

  resolve(reference: string | undefined): TaskService {
    const id = reference === undefined ? this.defaultId() : this.lookup(reference)?.id;
    if (reference === undefined && id === undefined) throw new DomainError('No active project. Create or restore a project first.', 404);
    const service = id ? this.services.get(id) : undefined;
    if (service) return service;
    if (id && this.records.get(id)?.archivedAt) throw new DomainError('Project is archived. Restore it to continue.', 404);
    throw new DomainError('Project not found.', 404);
  }

  async project(reference: string) {
    await this.list();
    const project = this.lookup(reference);
    if (!project) throw new DomainError('Project not found.', 404);
    return project;
  }

  create(input: CreateProjectRequest) {
    return this.exclusive(async () => {
      const name = input.name.trim();
      const repositoryPath = input.repositoryPath.trim();
      if (!name) throw new DomainError('Give the project a name.');
      if (!repositoryPath) throw new DomainError('Choose the absolute path of a Git repository root.');
      if (input.initializeRepository) {
        if (!this.options.workspaces.initializeRepository) throw new DomainError('This workspace provider cannot initialize repositories.');
        try { await this.options.workspaces.initializeRepository(repositoryPath); }
        catch (error) { throw new DomainError(`Could not initialize a Git repository in this folder. ${error instanceof Error ? error.message : ''}`.trim()); }
      }
      try { await this.options.workspaces.validateRepository?.(repositoryPath); }
      catch (error) { throw new DomainError(`Choose a Git repository root with at least one commit, or let Muon initialize one in this folder. ${error instanceof Error ? error.message : ''}`.trim()); }
      const taken = (await this.list()).map(project => project.identifier);
      const identifier = input.identifier?.trim().toUpperCase() || deriveIdentifier(name, taken);
      if (!IDENTIFIER.test(identifier)) throw new DomainError('Identifiers are 2 to 5 letters or digits, starting with a letter.');
      if (taken.some(value => value.toUpperCase() === identifier)) throw new DomainError(`Identifier ${identifier} is already used by another project.`, 409);
      const project: Project = { id: randomUUID(), workspaceId: this.options.scope.workspaceId, ownerUserId: this.options.scope.userId, name, identifier, repositoryPath, createdAt: new Date().toISOString() };
      await this.options.repository.initialize(this.scopeFor(project.id), project, this.options.defaultSettings);
      this.records.set(project.id, project);
      this.order.push(project.id);
      await this.launch(project);
      return project;
    });
  }

  archive(reference: string) {
    return this.exclusive(async () => {
      const project = await this.project(reference);
      const service = this.services.get(project.id);
      if (!service) throw new DomainError(project.archivedAt ? 'Project is already archived.' : 'Project not found.', project.archivedAt ? 409 : 404);
      await service.quiesceForArchive();
      this.services.delete(project.id);
      const archived = { ...project, archivedAt: new Date().toISOString() };
      await this.options.repository.saveProject(this.scopeFor(project.id), archived);
      this.records.set(project.id, archived);
      return archived;
    });
  }

  restore(reference: string) {
    return this.exclusive(async () => {
      const project = await this.project(reference);
      if (!project.archivedAt) throw new DomainError('Project is not archived.', 409);
      const { archivedAt: _archivedAt, ...restored } = project;
      await this.options.repository.saveProject(this.scopeFor(project.id), restored);
      this.records.set(project.id, restored);
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
export function singleProjectResolver(service: TaskService): ProjectResolver {
  const project = () => service.snapshot().then(snapshot => snapshot.project);
  const matches = async (reference: string) => {
    const current = await project();
    if (reference !== current.id && reference.toLowerCase() !== current.identifier.toLowerCase()) throw new DomainError('Project not found.', 404);
    return current;
  };
  const unsupported = () => { throw new DomainError('This server runs a single fixed project.', 405); };
  return {
    list: async () => [await project()],
    resolve: reference => {
      if (reference !== undefined && reference !== service.scope.projectId) {
        // Identifier lookups need the record; fixtures address the project by ID.
        throw new DomainError('Project not found.', 404);
      }
      return service;
    },
    project: matches,
    create: unsupported, archive: unsupported, restore: unsupported,
  };
}
