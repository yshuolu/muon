import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { resolve } from 'node:path';
import { DomainError, ConflictError, type ArtifactStore } from './ports';
import type { TaskService } from './task-service';
import type { Task } from '../shared/types';
import {
  chiefMessageSchema, createTaskSchema, editTaskSchema, emptyMutationSchema, listAttentionQuerySchema, planningChatMessageSchema,
  listTasksQuerySchema, planCommentSchema, requestChangesSchema, retryTaskSchema, reviewSchema, settingsSchema,
} from '../shared/api-contract';

export interface HttpRequestAccess {
  authorize(request: Request): void | Promise<void>;
  observe?(request: Request, response: Response): void | Promise<void>;
}
export function createHttpApp(service: TaskService, artifacts: ArtifactStore, options: { port?: number; ready?: () => boolean; staticRoot?: string; access?: HttpRequestAccess } = {}) {
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
    if (!['GET', 'HEAD'].includes(c.req.method) && !c.req.header('content-type')?.includes('application/json')) return c.json({ error: 'Use application/json for mutations.' }, 415);
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
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: 'Request exceeds 1 MB.' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON.' }, 400);
    if (error instanceof ConflictError) return c.json({ error: error.message }, 409);
    if (error instanceof DomainError) return c.json({ error: error.message }, error.status as 400);
    console.error(error);
    return c.json({ error: 'The local server could not complete this request.' }, 500);
  });
  app.get('/api/health', c => c.json({ ok: true }));
  app.get('/api/state', async c => c.json(await service.snapshot()));
  // All resource lookups use the service's project scope. Identifiers are a convenience;
  // stable UUIDs remain the canonical references in returned records.
  const resolveTask = (tasks: Task[], reference: string) => {
    const task = tasks.find(item => item.id === reference) ?? tasks.find(item => item.identifier.toLowerCase() === reference.toLowerCase());
    if (!task) throw new DomainError('Task not found.', 404);
    return task;
  };
  const taskByReference = async (reference: string) => resolveTask((await service.snapshot()).tasks, reference);
  const resolveRelations = async <T extends { parentId?: string | null; blockedByIds?: string[] }>(input: T): Promise<T> => {
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
  app.get('/api/project', async c => c.json((await service.snapshot()).project));
  app.get('/api/settings', async c => c.json((await service.snapshot()).settings));
  app.get('/api/runtime', async c => c.json((await service.snapshot()).runtime));
  app.get('/api/attention', async c => {
    const query = listAttentionQuerySchema.parse(c.req.query());
    const items = (await service.snapshot()).attention;
    return c.json(query.unread === undefined ? items : items.filter(item => !item.readAt === query.unread));
  });
  app.get('/api/chief/messages', async c => c.json((await service.snapshot()).messages));
  app.get('/api/tasks', async c => {
    const query = listTasksQuerySchema.parse(c.req.query());
    const tasks = (await service.snapshot()).tasks;
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
  app.get('/api/tasks/:id', async c => c.json(await taskByReference(c.req.param('id'))));
  for (const [resource, property] of [['plans', 'plans'], ['evidence', 'evidence'], ['files', 'changedFiles'], ['activity', 'activity'], ['runs', 'runs']] as const) {
    app.get(`/api/tasks/:id/${resource}`, async c => c.json((await taskByReference(c.req.param('id')))[property] ?? []));
  }
  app.get('/api/tasks/:id/plan-discussion', async c => c.json((await taskByReference(c.req.param('id'))).planDiscussion ?? []));
  app.get('/api/tasks/:id/subtasks', async c => {
    const tasks = (await service.snapshot()).tasks;
    const task = resolveTask(tasks, c.req.param('id'));
    return c.json(tasks.filter(item => item.parentId === task.id));
  });
  app.get('/api/tasks/:id/dependencies', async c => {
    const tasks = (await service.snapshot()).tasks;
    const task = resolveTask(tasks, c.req.param('id'));
    return c.json(task.blockedByIds.map(id => resolveTask(tasks, id)));
  });
  const planByReference = async (taskReference: string, planId: string) => {
    const task = await taskByReference(taskReference);
    const plan = task.plans.find(item => item.id === planId);
    if (!plan) throw new DomainError('RFC not found.', 404);
    return plan;
  };
  app.get('/api/tasks/:id/plans/:planId', async c => c.json(await planByReference(c.req.param('id'), c.req.param('planId'))));
  app.get('/api/tasks/:id/plans/:planId/dependencies/:dependencyId/patch', async c => {
    const plan = await planByReference(c.req.param('id'), c.req.param('planId'));
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
  app.post('/api/tasks', async c => c.json(await service.createTask(await resolveRelations(createTaskSchema.parse(await c.req.json()))), 201));
  app.patch('/api/tasks/:id', async c => {
    const input = editTaskSchema.parse(await c.req.json());
    return c.json(await service.editTask((await taskByReference(c.req.param('id'))).id, await resolveRelations(input)));
  });
  app.post('/api/tasks/:id/cancel', async c => {
    emptyMutationSchema.parse(await c.req.json());
    return c.json(await service.editTask((await taskByReference(c.req.param('id'))).id, { status: 'canceled' }));
  });
  app.post('/api/tasks/:id/approve', async c => {
    const { planId } = reviewSchema.parse(await c.req.json());
    return c.json(await service.approve((await taskByReference(c.req.param('id'))).id, planId));
  });
  app.post('/api/tasks/:id/request-changes', async c => {
    const body = requestChangesSchema.parse(await c.req.json());
    return c.json(await service.requestChanges((await taskByReference(c.req.param('id'))).id, body.planId, body.feedback));
  });
  app.post('/api/tasks/:id/plan-discussion', async c => {
    const body = planCommentSchema.parse(await c.req.json());
    return c.json(await service.commentOnPlan((await taskByReference(c.req.param('id'))).id, body.planId, body.content));
  });
  app.post('/api/tasks/:id/retry', async c => {
    const input = retryTaskSchema.parse(await c.req.json());
    return c.json(await service.retry((await taskByReference(c.req.param('id'))).id, input));
  });
  app.post('/api/attention/:id/read', async c => { await service.markRead(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/chief/messages', async c => {
    const { content } = chiefMessageSchema.parse(await c.req.json());
    return c.json(await service.sendChief(content), 202);
  });
  app.post('/api/planning-chats', async c => {
    emptyMutationSchema.parse(await c.req.json());
    return c.json(service.createPlanningChat(), 201);
  });
  app.get('/api/planning-chats/:id', async c => c.json(service.getPlanningChat(c.req.param('id'))));
  app.post('/api/planning-chats/:id/messages', async c => {
    const { content } = planningChatMessageSchema.parse(await c.req.json());
    return c.json(await service.sendPlanningChat(c.req.param('id'), content), 202);
  });
  app.post('/api/planning-chats/:id/taskify', async c => {
    const input = createTaskSchema.parse(await c.req.json());
    return c.json(await service.taskifyPlanningChat(c.req.param('id'), await resolveRelations(input)), 201);
  });
  app.delete('/api/planning-chats/:id', async c => {
    service.discardPlanningChat(c.req.param('id')); return c.json({ ok: true });
  });
  app.patch('/api/settings', async c => {
    const input = settingsSchema.parse(await c.req.json());
    await service.updateSettings(input); return c.json({ ok: true });
  });
  app.get('/api/artifacts/:id', async c => {
    const artifact = await artifacts.read(service.scope, c.req.param('id'));
    if (!artifact) return c.json({ error: 'Artifact not found.' }, 404);
    const data = new Uint8Array(artifact.data);
    const headers = new Headers({ 'Content-Type': artifact.mime, 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
    // Browsers seek through recordings using byte ranges, including open-ended and suffix requests.
    const range = c.req.header('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const first = match?.[1] ? Number(match[1]) : undefined;
      const last = match?.[2] ? Number(match[2]) : undefined;
      const start = first ?? Math.max(0, data.length - (last ?? 0));
      const end = first === undefined ? data.length - 1 : Math.min(last ?? data.length - 1, data.length - 1);
      if (!match || (first === undefined && last === undefined) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= data.length || end < start) {
        headers.set('Content-Range', `bytes */${data.length}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${data.length}`);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(data.slice(start, end + 1), { status: 206, headers });
    }
    headers.set('Content-Length', String(data.length));
    return new Response(data, { headers });
  });
  app.all('/api/*', c => c.json({ error: 'API route not found.' }, 404));
  app.use('/*', serveStatic({ root: options.staticRoot ?? resolve('dist') }));
  app.get('*', serveStatic({ path: resolve(options.staticRoot ?? 'dist', 'index.html') }));
  return app;
}
