import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { resolve } from 'node:path';
import { DomainError, ConflictError, type ArtifactStore } from './ports';
import type { TaskService } from './task-service';

const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const createSchema = z.strictObject({
  title: z.string().trim().min(1).max(240), description: z.string().max(30_000).optional(),
  provider: z.enum(['claude', 'codex']).optional(), priority: priority.optional(),
  status: z.enum(['backlog', 'todo']).optional(), labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  parentId: z.string().nullable().optional(), blockedByIds: z.array(z.string()).max(100).optional(),
  kind: z.enum(['coding', 'group']).optional(),
});
const editSchema = createSchema.omit({ kind: true }).partial().extend({ status: z.enum(['backlog', 'todo', 'canceled']).optional() });
const settingsSchema = z.strictObject({
  maxConcurrentAgents: z.number().int().min(1).max(8).optional(), dispatcherEnabled: z.boolean().optional(),
  defaultProvider: z.enum(['claude', 'codex']).optional(), repositoryPath: z.string().max(2000).optional(), projectName: z.string().trim().min(1).max(100).optional(),
});
export function createHttpApp(service: TaskService, artifacts: ArtifactStore, options: { port?: number; ready?: () => boolean; staticRoot?: string } = {}) {
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
    await next();
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
  app.post('/api/tasks', async c => c.json(await service.createTask(createSchema.parse(await c.req.json())), 201));
  app.patch('/api/tasks/:id', async c => c.json(await service.editTask(c.req.param('id'), editSchema.parse(await c.req.json()))));
  app.post('/api/tasks/:id/approve', async c => {
    const { planId } = z.strictObject({ planId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await service.approve(c.req.param('id'), planId));
  });
  app.post('/api/tasks/:id/request-changes', async c => {
    const body = z.strictObject({ planId: z.string().min(1), feedback: z.string().trim().min(1).max(20_000) }).parse(await c.req.json());
    return c.json(await service.requestChanges(c.req.param('id'), body.planId, body.feedback));
  });
  app.post('/api/tasks/:id/retry', async c => {
    const input = z.strictObject({ mode: z.enum(['retry', 'fix', 'replan']).optional(), feedback: z.string().trim().max(20_000).optional() }).parse(await c.req.json());
    return c.json(await service.retry(c.req.param('id'), input));
  });
  app.post('/api/attention/:id/read', async c => { await service.markRead(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/chief/messages', async c => {
    const { content } = z.strictObject({ content: z.string().trim().min(1).max(30_000) }).parse(await c.req.json());
    return c.json(await service.sendChief(content), 202);
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
