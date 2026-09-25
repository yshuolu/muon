import { z } from 'zod';

/** Request validation shared by the REST server, browser client, and CLI. */
export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const taskReferenceSchema = z.string().trim().min(1).max(240);
export const taskStatusSchema = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled']);
export const modelIdentifierSchema = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/, 'Enter a model alias or identifier without spaces.');
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
  chiefProvider: z.enum(['claude', 'codex']).nullable().optional(),
  chiefModel: modelIdentifierSchema.nullable().optional(),
  chiefSoul: z.string().trim().max(20_000).nullable().optional(),
});
export const assetCommentAnchorSchema = z.strictObject({
  quote: z.string().min(1).max(2000), prefix: z.string().max(64), suffix: z.string().max(64), start: z.number().int().min(0),
});
export const createAssetCommentSchema = z.strictObject({
  content: z.string().trim().min(1).max(4000), requestId: z.uuid(), anchor: assetCommentAnchorSchema.optional(),
});
export const updateAssetCommentSchema = z.strictObject({ content: z.string().trim().min(1).max(4000) });
export const projectIdentifierSchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,4}$/, 'Identifiers are 2 to 5 letters or digits, starting with a letter.');
export const createProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(100), repositoryPath: z.string().trim().min(1).max(2000),
  identifier: projectIdentifierSchema.optional(),
  /** Create a Git repository with an initial commit when the folder is not one yet. */
  initializeRepository: z.boolean().optional(),
});
export const updateProjectSchema = z.strictObject({ name: z.string().trim().min(1).max(100).optional(), repositoryPath: z.string().trim().max(2000).optional() });
export const retryTaskSchema = z.strictObject({ mode: z.enum(['retry', 'resume', 'fix', 'replan']).optional(), feedback: z.string().trim().max(20_000).optional() });
export const reviewSchema = z.strictObject({ planId: z.string().min(1) });
export const requestChangesSchema = reviewSchema.extend({ feedback: z.string().trim().min(1).max(20_000) });
export const planCommentSchema = reviewSchema.extend({ content: z.string().trim().min(1).max(20_000) });
export const taskCommentSchema = z.strictObject({
  content: z.string().trim().min(1).max(20_000), requestId: z.uuid(), mode: z.enum(['message', 'replan']).optional(),
});
export const chiefMessageSchema = z.strictObject({ content: z.string().trim().min(1).max(30_000) });
export const planningChatMessageSchema = z.strictObject({ content: z.string().trim().min(1).max(30_000) });
export const updatePlanningChatSchema = z.strictObject({
  model: modelIdentifierSchema.nullable().optional(), provider: z.enum(['claude', 'codex']).optional(),
}).refine(value => value.model !== undefined || value.provider !== undefined, 'Choose a provider or a model.');
export const emptyMutationSchema = z.strictObject({});
export const importAssetSchema = z.strictObject({ path: z.string().min(1).max(2000) });
export const attachAssetSchema = z.strictObject({ assetId: z.string().min(1).max(200) });
export const createNoteSchema = z.strictObject({
  name: z.string().trim().min(1).max(255), content: z.string().max(200_000).refine(value => value.trim().length > 0, 'Write something in the note.'),
});
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
export type TaskCommentRequest = z.infer<typeof taskCommentSchema>;
export type ChiefMessageRequest = z.infer<typeof chiefMessageSchema>;
export type UpdatePlanningChatRequest = z.infer<typeof updatePlanningChatSchema>;
export type CreateNoteRequest = z.infer<typeof createNoteSchema>;
export type CreateProjectRequest = z.input<typeof createProjectSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectSchema>;
export type ListTasksQuery = z.input<typeof listTasksQuerySchema>;
export type ListAttentionQuery = z.input<typeof listAttentionQuerySchema>;
export interface ApiErrorResponse { error: string }
