import { z } from 'zod';

/** Request validation shared by the REST server, browser client, and CLI. */
export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const taskReferenceSchema = z.string().trim().min(1).max(240);
export const taskStatusSchema = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled']);
export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(240), description: z.string().max(30_000).optional(),
  provider: z.enum(['claude', 'codex']).optional(), priority: prioritySchema.optional(),
  status: z.enum(['backlog', 'todo']).optional(), labels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  parentId: taskReferenceSchema.nullable().optional(), blockedByIds: z.array(taskReferenceSchema).max(100).optional(),
  kind: z.enum(['coding', 'group']).optional(),
});
export const editTaskSchema = createTaskSchema.omit({ kind: true }).partial().extend({ status: z.enum(['backlog', 'todo', 'canceled']).optional() });
export const settingsSchema = z.strictObject({
  maxConcurrentAgents: z.number().int().min(1).max(8).optional(), dispatcherEnabled: z.boolean().optional(),
  defaultProvider: z.enum(['claude', 'codex']).optional(), repositoryPath: z.string().max(2000).optional(), projectName: z.string().trim().min(1).max(100).optional(),
});
export const retryTaskSchema = z.strictObject({ mode: z.enum(['retry', 'resume', 'fix', 'replan']).optional(), feedback: z.string().trim().max(20_000).optional() });
export const reviewSchema = z.strictObject({ planId: z.string().min(1) });
export const requestChangesSchema = reviewSchema.extend({ feedback: z.string().trim().min(1).max(20_000) });
export const planCommentSchema = reviewSchema.extend({ content: z.string().trim().min(1).max(20_000) });
export const chiefMessageSchema = z.strictObject({ content: z.string().trim().min(1).max(30_000) });
export const emptyMutationSchema = z.strictObject({});
export const listTasksQuerySchema = z.strictObject({
  status: taskStatusSchema.optional(),
  parentId: taskReferenceSchema.transform(value => value === 'null' ? null : value).optional(),
  blockedById: taskReferenceSchema.optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  kind: z.enum(['coding', 'group']).optional(),
  search: z.string().trim().max(1000).optional(),
});
export const listAttentionQuerySchema = z.strictObject({
  unread: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
});

export type CreateTaskRequest = z.infer<typeof createTaskSchema>;
export type EditTaskRequest = z.infer<typeof editTaskSchema>;
export type UpdateSettingsRequest = z.infer<typeof settingsSchema>;
export type RetryTaskRequest = z.infer<typeof retryTaskSchema>;
export type ReviewPlanRequest = z.infer<typeof reviewSchema>;
export type RequestPlanChangesRequest = z.infer<typeof requestChangesSchema>;
export type PlanCommentRequest = z.infer<typeof planCommentSchema>;
export type ChiefMessageRequest = z.infer<typeof chiefMessageSchema>;
export type ListTasksQuery = z.input<typeof listTasksQuerySchema>;
export type ListAttentionQuery = z.input<typeof listAttentionQuerySchema>;
export interface ApiErrorResponse { error: string }
