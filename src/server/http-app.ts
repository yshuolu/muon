import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { resolve } from 'node:path';
import { DomainError, ConflictError, type ArtifactStore } from './ports';
import type { TaskService } from './task-service';
import type { ProjectResolver } from './project-registry';
import type { Task } from '../shared/types';
import {
  chiefMessageSchema, createTaskSchema, editTaskSchema, emptyMutationSchema, listAttentionQuerySchema, planningChatMessageSchema,
  listTasksQuerySchema, planCommentSchema, taskCommentSchema, requestChangesSchema, retryTaskSchema, reviewSchema, settingsSchema, attachAssetSchema, createNoteSchema, importAssetSchema, updatePlanningChatSchema,
  createProjectSchema, updateProjectSchema,
} from '../shared/api-contract';

export interface HttpRequestAccess {
  authorize(request: Request): void | Promise<void>;
  observe?(request: Request, response: Response): void | Promise<void>;
}
function isAssetUpload(path: string, method: string) {
  return method === 'POST' && /^\/api\/(projects\/[^/]+\/)?(assets|tasks\/[^/]+\/assets)$/.test(path);
}

function rangeResponse(data: Uint8Array<ArrayBuffer>, headers: Headers, range?: string) {
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const first = match?.[1] ? Number(match[1]) : undefined;
    const last = match?.[2] ? Number(match[2]) : undefined;
    const start = first ?? Math.max(0, data.length - (last ?? 0));
    const end = first === undefined ? data.length - 1 : Math.min(last ?? data.length - 1, data.length - 1);
    if (!match || (first === undefined && last === undefined) || (first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last)) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= data.length || end < start) {
      headers.set('Content-Range', `bytes */${data.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${data.length}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(data.slice(start, end + 1), { status: 206, headers });
  }
  headers.set('Content-Length', String(data.length));
  return new Response(data, { headers });
}

function assetResponse(bytes: Uint8Array, mediaType: string, name: string, range?: string, download = false) {
  const data = new Uint8Array(bytes);
  const safeInline = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav)|text\/(plain|markdown)|application\/json)$/.test(mediaType);
  const filename = name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'asset';
  const wellFormedName = Array.from(name, char => char.length === 1 && /[\uD800-\uDFFF]/.test(char) ? '�' : char).join('');
  const utf8Name = encodeURIComponent(wellFormedName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
  const headers = new Headers({
    'Content-Type': mediaType, 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes', 'Content-Disposition': `${download || !safeInline ? 'attachment' : 'inline'}; filename="${filename}"; filename*=UTF-8''${utf8Name}`,
  });
  return rangeResponse(data, headers, range);
}

type ProjectEnv = { Variables: { service: TaskService } };

/** Every project resource is served under `/api/projects/:project` and, for the default project, under `/api`. */
function projectRoutes(projects: ProjectResolver) {
  const app = new Hono<ProjectEnv>();
  app.use('*', async (c, next) => {
    c.set('service', projects.resolve(c.req.param('project')));
    await next();
  });
  // All resource lookups use the service's project scope. Identifiers are a convenience;
  // stable UUIDs remain the canonical references in returned records.
  const resolveTask = (tasks: Task[], reference: string) => {
    const task = tasks.find(item => item.id === reference) ?? tasks.find(item => item.identifier.toLowerCase() === reference.toLowerCase());
    if (!task) throw new DomainError('Task not found.', 404);
    return task;
  };
  const taskByReference = async (service: TaskService, reference: string) => resolveTask((await service.snapshot()).tasks, reference);
  const resolveRelations = async <T extends { parentId?: string | null; blockedByIds?: string[] }>(service: TaskService, input: T): Promise<T> => {
    if (!input.parentId && !input.blockedByIds?.length) return input;
    const tasks = (await service.snapshot()).tasks;
    const relationId = (reference: string) => {
      try { return resolveTask(tasks, reference).id; }
      catch { throw new DomainError('Related tasks must belong to this project.'); }
    };
    return {
      ...input,
      ...(input.parentId ? { parentId: relationId(input.parentId) } : {}),
      ...(input.blockedByIds ? { blockedByIds: input.blockedByIds.map(relationId) } : {}),
    };
  };
  app.get('/state', async c => c.json({ ...await c.get('service').snapshot(), projects: await projects.list() }));
  app.get('/project', async c => c.json((await c.get('service').snapshot()).project));
  app.get('/settings', async c => c.json((await c.get('service').snapshot()).settings));
  app.get('/runtime', async c => c.json((await c.get('service').snapshot()).runtime));
  app.get('/attention', async c => {
    const query = listAttentionQuerySchema.parse(c.req.query());
    const items = (await c.get('service').snapshot()).attention;
    return c.json(query.unread === undefined ? items : items.filter(item => !item.readAt === query.unread));
  });
  app.get('/chief/messages', async c => c.json((await c.get('service').snapshot()).messages));
  app.get('/tasks', async c => {
    const query = listTasksQuerySchema.parse(c.req.query());
    const tasks = (await c.get('service').snapshot()).tasks;
    const parentId = query.parentId == null ? query.parentId : resolveTask(tasks, query.parentId).id;
    const blockedById = query.blockedById ? resolveTask(tasks, query.blockedById).id : undefined;
    const search = query.search?.toLowerCase();
    return c.json(tasks.filter(task =>
      (query.status === undefined || task.status === query.status) &&
      (parentId === undefined || task.parentId === parentId) &&
      (blockedById === undefined || task.blockedByIds.includes(blockedById)) &&
      (query.provider === undefined || task.provider === query.provider) &&
      (query.kind === undefined || (task.kind ?? 'coding') === query.kind) &&
      (!search || [task.identifier, task.title, task.description, ...task.labels].some(value => value.toLowerCase().includes(search)))));
  });
  app.get('/tasks/:id', async c => c.json(await taskByReference(c.get('service'), c.req.param('id'))));
  app.get('/tasks/:id/assets', async c => { const service = c.get('service'); return c.json(await service.listTaskAssets((await taskByReference(service, c.req.param('id'))).id)); });
  const uploadedFile = async (request: Request) => {
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data;')) throw new DomainError('Upload a file with multipart/form-data.', 415);
    let form: FormData;
    try { form = await request.formData(); } catch { throw new DomainError('Invalid multipart upload.'); }
    const file = form.get('file');
    if (!(file instanceof File) || form.getAll('file').length !== 1 || [...form.keys()].some(key => key !== 'file')) throw new DomainError('Upload exactly one file in the file field.');
    if (file.size > 100 * 1024 * 1024) throw new DomainError('Assets must be at most 100 MiB.', 413);
    return { name: file.name, mediaType: file.type || undefined, data: new Uint8Array(await file.arrayBuffer()) };
  };
  app.get('/assets', async c => c.json(await c.get('service').listAssets()));
  app.post('/assets', async c => c.json(await c.get('service').uploadAsset(await uploadedFile(c.req.raw)), 201));
  app.post('/assets/notes', async c => c.json(await c.get('service').createNote(createNoteSchema.parse(await c.req.json())), 201));
  app.post('/tasks/:id/assets', async c => {
    const service = c.get('service');
    const task = await taskByReference(service, c.req.param('id'));
    return c.json(await service.uploadTaskAsset(task.id, await uploadedFile(c.req.raw)), 201);
  });
  app.post('/tasks/:id/assets/attach', async c => {
    const service = c.get('service');
    const { assetId } = attachAssetSchema.parse(await c.req.json());
    return c.json(await service.attachTaskAsset((await taskByReference(service, c.req.param('id'))).id, assetId));
  });
  app.post('/tasks/:id/assets/import', async c => {
    const service = c.get('service');
    const { path } = importAssetSchema.parse(await c.req.json());
    return c.json(await service.importTaskAsset((await taskByReference(service, c.req.param('id'))).id, path), 201);
  });
  app.get('/assets/:id', async c => c.json(await c.get('service').getAsset(c.req.param('id'))));
  app.get('/assets/:id/content', async c => {
    const { asset, data } = await c.get('service').readAsset(c.req.param('id'));
    return assetResponse(data, asset.mediaType, asset.name, c.req.header('range'), c.req.query('download') === '1');
  });
  for (const [resource, property] of [['plans', 'plans'], ['evidence', 'evidence'], ['files', 'changedFiles'], ['activity', 'activity'], ['runs', 'runs']] as const) {
    app.get(`/tasks/:id/${resource}`, async c => c.json((await taskByReference(c.get('service'), c.req.param('id')))[property] ?? []));
  }
  app.get('/tasks/:id/plan-discussion', async c => c.json((await taskByReference(c.get('service'), c.req.param('id'))).planDiscussion ?? []));
  app.get('/tasks/:id/comments', async c => c.json((await taskByReference(c.get('service'), c.req.param('id'))).comments ?? []));
  app.get('/tasks/:id/subtasks', async c => {
    const tasks = (await c.get('service').snapshot()).tasks;
    const task = resolveTask(tasks, c.req.param('id'));
    return c.json(tasks.filter(item => item.parentId === task.id));
  });
  app.get('/tasks/:id/dependencies', async c => {
    const tasks = (await c.get('service').snapshot()).tasks;
    const task = resolveTask(tasks, c.req.param('id'));
    return c.json(task.blockedByIds.map(id => resolveTask(tasks, id)));
  });
  const planByReference = async (service: TaskService, taskReference: string, planId: string) => {
    const task = await taskByReference(service, taskReference);
    const plan = task.plans.find(item => item.id === planId);
    if (!plan) throw new DomainError('RFC not found.', 404);
    return plan;
  };
  app.get('/tasks/:id/plans/:planId', async c => c.json(await planByReference(c.get('service'), c.req.param('id'), c.req.param('planId'))));
  app.get('/tasks/:id/plans/:planId/dependencies/:dependencyId/patch', async c => {
    const plan = await planByReference(c.get('service'), c.req.param('id'), c.req.param('planId'));
    const reference = c.req.param('dependencyId');
    const dependency = plan.dependencyInputs?.find(item => item.taskId === reference || item.identifier.toLowerCase() === reference.toLowerCase());
    if (!dependency) throw new DomainError('RFC dependency snapshot not found.', 404);
    const data = Buffer.from(dependency.changes.patch, dependency.changes.patchEncoding === 'base64' ? 'base64' : 'utf8');
    const filename = `${dependency.identifier}-${dependency.changes.sha256.slice(0, 12)}.patch`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return new Response(data, { headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
    } });
  });
  app.post('/tasks', async c => { const service = c.get('service'); return c.json(await service.createTask(await resolveRelations(service, createTaskSchema.parse(await c.req.json()))), 201); });
  app.patch('/tasks/:id', async c => {
    const service = c.get('service');
    const input = editTaskSchema.parse(await c.req.json());
    return c.json(await service.editTask((await taskByReference(service, c.req.param('id'))).id, await resolveRelations(service, input)));
  });
  app.post('/tasks/:id/cancel', async c => {
    const service = c.get('service');
    emptyMutationSchema.parse(await c.req.json());
    return c.json(await service.editTask((await taskByReference(service, c.req.param('id'))).id, { status: 'canceled' }));
  });
  app.post('/tasks/:id/approve', async c => {
    const service = c.get('service');
    const { planId } = reviewSchema.parse(await c.req.json());
    return c.json(await service.approve((await taskByReference(service, c.req.param('id'))).id, planId));
  });
  app.post('/tasks/:id/request-changes', async c => {
    const service = c.get('service');
    const body = requestChangesSchema.parse(await c.req.json());
    return c.json(await service.requestChanges((await taskByReference(service, c.req.param('id'))).id, body.planId, body.feedback));
  });
  app.post('/tasks/:id/plan-discussion', async c => {
    const service = c.get('service');
    const body = planCommentSchema.parse(await c.req.json());
    return c.json(await service.commentOnPlan((await taskByReference(service, c.req.param('id'))).id, body.planId, body.content));
  });
  app.post('/tasks/:id/comments', async c => {
    const service = c.get('service');
    const input = taskCommentSchema.parse(await c.req.json());
    return c.json(await service.commentOnTask((await taskByReference(service, c.req.param('id'))).id, input));
  });
  app.post('/tasks/:id/comments/retry', async c => {
    const service = c.get('service');
    emptyMutationSchema.parse(await c.req.json());
    return c.json(await service.retryTaskComments((await taskByReference(service, c.req.param('id'))).id));
  });
  app.post('/tasks/:id/retry', async c => {
    const service = c.get('service');
    const input = retryTaskSchema.parse(await c.req.json());
    return c.json(await service.retry((await taskByReference(service, c.req.param('id'))).id, input));
  });
  app.post('/attention/:id/read', async c => { await c.get('service').markRead(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/chief/messages', async c => {
    const { content } = chiefMessageSchema.parse(await c.req.json());
    return c.json(await c.get('service').sendChief(content), 202);
  });
  app.post('/planning-chats', async c => {
    emptyMutationSchema.parse(await c.req.json());
    return c.json(c.get('service').createPlanningChat(), 201);
  });
  app.get('/planning-chats/:id', async c => c.json(c.get('service').getPlanningChat(c.req.param('id'))));
  app.patch('/planning-chats/:id', async c => {
    const { model } = updatePlanningChatSchema.parse(await c.req.json());
    return c.json(c.get('service').updatePlanningChat(c.req.param('id'), model));
  });
  app.post('/planning-chats/:id/messages', async c => {
    const { content } = planningChatMessageSchema.parse(await c.req.json());
    return c.json(await c.get('service').sendPlanningChat(c.req.param('id'), content), 202);
  });
  app.post('/planning-chats/:id/taskify', async c => {
    const service = c.get('service');
    const input = createTaskSchema.parse(await c.req.json());
    return c.json(await service.taskifyPlanningChat(c.req.param('id'), await resolveRelations(service, input)), 201);
  });
  app.delete('/planning-chats/:id', async c => {
    c.get('service').discardPlanningChat(c.req.param('id')); return c.json({ ok: true });
  });
  app.patch('/settings', async c => {
    const input = settingsSchema.parse(await c.req.json());
    await c.get('service').updateSettings(input); return c.json({ ok: true });
  });
  app.get('/artifacts/:id', async c => {
    const artifact = await c.get('service').readLegacyArtifact(c.req.param('id'));
    if (!artifact) return c.json({ error: 'Artifact not found.' }, 404);
    // Browsers seek through recordings using byte ranges, including open-ended and suffix requests.
    const headers = new Headers({ 'Content-Type': artifact.mime, 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
    return rangeResponse(new Uint8Array(artifact.data), headers, c.req.header('range'));
  });
  return app;
}

export function createHttpApp(projects: ProjectResolver, artifacts: ArtifactStore, options: { port?: number; ready?: () => boolean; staticRoot?: string; access?: HttpRequestAccess } = {}) {
  void artifacts; // Legacy artifact bytes are served through each project's service; the store stays injectable for tests.
  const app = new Hono();
  const hosts = new Set([`127.0.0.1:${options.port ?? 4310}`, `localhost:${options.port ?? 4310}`, '127.0.0.1:5173', 'localhost:5173']);
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!hosts.has(host)) return c.json({ error: 'Unrecognized local host.' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      try { const url = new URL(origin); if (url.protocol !== 'http:' || !hosts.has(url.host)) return c.json({ error: 'Cross-origin access is not allowed.' }, 403); }
      catch { return c.json({ error: 'Invalid origin.' }, 403); }
    }
    const multipart = isAssetUpload(c.req.path, c.req.method) && c.req.header('content-type')?.startsWith('multipart/form-data;');
    if (!['GET', 'HEAD'].includes(c.req.method) && !multipart && !c.req.header('content-type')?.includes('application/json')) return c.json({ error: 'Use application/json for mutations, or multipart/form-data for asset uploads.' }, 415);
    if (options.ready && !options.ready()) return c.json({ error: 'Muon is starting. Try again shortly.' }, 503);
    // Body-limit middleware may replace c.req.raw while buffering a stream.
    // Keep the admitted request identity for the successful-write observer.
    const accessRequest = c.req.raw;
    await options.access?.authorize(accessRequest);
    await next();
    if (c.res.ok) await options.access?.observe?.(accessRequest, c.res);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });
  app.use('/api/*', async (c, next) => {
    const upload = isAssetUpload(c.req.path, c.req.method) && c.req.header('content-type')?.startsWith('multipart/form-data;');
    return bodyLimit({ maxSize: (upload ? 101 : 1) * 1024 * 1024, onError: context => context.json({ error: upload ? 'Asset upload request exceeds 101 MiB.' : 'Request exceeds 1 MB.' }, 413) })(c, next);
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON.' }, 400);
    if (error instanceof ConflictError) return c.json({ error: error.message }, 409);
    if (error instanceof DomainError) return c.json({ error: error.message }, error.status as 400);
    console.error(error);
    return c.json({ error: 'The local server could not complete this request.' }, 500);
  });
  app.get('/api/health', c => c.json({ ok: true }));
  // Workspace resources: the project list and lifecycle. Registered before the project mounts so
  // `/api/projects` is never interpreted as a default-project resource.
  app.get('/api/projects', async c => c.json(await projects.list()));
  app.post('/api/projects', async c => c.json(await projects.create(createProjectSchema.parse(await c.req.json())), 201));
  app.get('/api/projects/:project', async c => c.json(await projects.project(c.req.param('project'))));
  app.patch('/api/projects/:project', async c => {
    const input = updateProjectSchema.parse(await c.req.json());
    const service = projects.resolve(c.req.param('project'));
    await service.updateSettings({ ...(input.name !== undefined ? { projectName: input.name } : {}), ...(input.repositoryPath !== undefined ? { repositoryPath: input.repositoryPath } : {}) });
    return c.json((await service.snapshot()).project);
  });
  app.post('/api/projects/:project/archive', async c => { emptyMutationSchema.parse(await c.req.json()); return c.json(await projects.archive(c.req.param('project'))); });
  app.post('/api/projects/:project/restore', async c => { emptyMutationSchema.parse(await c.req.json()); return c.json(await projects.restore(c.req.param('project'))); });
  const routes = projectRoutes(projects);
  app.route('/api/projects/:project', routes);
  app.route('/api', routes);
  app.all('/api/*', c => c.json({ error: 'API route not found.' }, 404));
  app.use('/*', serveStatic({ root: options.staticRoot ?? resolve('dist') }));
  app.get('*', serveStatic({ path: resolve(options.staticRoot ?? 'dist', 'index.html') }));
  return app;
}
