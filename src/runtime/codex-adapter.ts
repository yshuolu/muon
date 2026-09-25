import type { AgentAdapter, AgentRequest, AgentResult } from './contracts.js';
import { JsonProcess, executableAvailable, validateWorkingDirectory } from './json-process.js';
import { errorMessage, record, text } from './protocol-values.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const isolatedFeatures = { apps: false, plugins: false, hooks: false, multi_agent: false };

// Extracts Orca's app-server handshake, request correlation and structured turn lifecycle.
export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;

  private readonly executable: string;
  private readonly prefixArgs: string[];
  private readonly model?: string;
  private readonly reasoningEffort?: string;
  private readonly bypassPermissions: boolean;

  constructor(executable?: string, options: { model?: string; reasoningEffort?: string; bypassPermissions?: boolean } = {}) {
    // Use the project's tested CLI version, while retaining an explicit host override.
    this.executable = executable ?? process.execPath;
    this.prefixArgs = executable ? [] : [createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')];
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.bypassPermissions = options.bypassPermissions ?? false;
  }

  available(): Promise<boolean> { return executableAvailable(this.executable, this.prefixArgs); }

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.provider !== this.provider) throw new Error('Codex adapter received another provider.');
    await validateWorkingDirectory(request.cwd);
    const chief = request.phase === 'chief';
    const chat = request.phase === 'chat';
    // The chief and planning chats work in the owner's real repository, never a task worktree:
    // they may read it and write temporary files to a scratch directory, and nothing else.
    const advisory = chief || chat;
    const readonly = request.phase === 'planning' || request.phase === 'discussion';
    const bypassPermissions = this.bypassPermissions && request.phase !== 'discussion' && !advisory;
    if (chief && !request.chiefCli) throw new Error('The chief requires a scoped Muon CLI session.');
    const cliExecutable = request.chiefCli?.command.replace(/^'|'$/g, '');
    if (chief && (!cliExecutable || !isAbsolute(cliExecutable) || !/^[/a-zA-Z0-9._-]+$/.test(cliExecutable))) throw new Error('The chief CLI must be an absolute executable path without shell metacharacters.');
    if (chief) {
      const api = new URL(request.chiefCli!.apiUrl);
      if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || api.username || api.password) throw new Error('The local chief requires a loopback API endpoint.');
    }
    // Codex sandboxes by working directory: an empty scratch directory keeps the repository read-only while the
    // launcher still reaches the loopback API. The prompt names the repository so the chief can inspect it.
    const scratch = advisory ? await mkdtemp(join(tmpdir(), chief ? 'muon-codex-chief-' : 'muon-codex-chat-')) : undefined;
    const workingDirectory = scratch ?? request.cwd;
    const prompt = advisory ? `The project repository is at ${request.cwd}. Read it with absolute paths; it is not writable from this session, and your working directory is a scratch folder for temporary files.\n${request.prompt}` : request.prompt;
    const pending = new Map<number, PendingRequest>();
    let nextRequestId = 1;
    let sessionId: string | undefined;
    let turnId: string | undefined;
    let receivedTurnId!: (id: string) => void;
    const turnIdentity = new Promise<string>((resolve) => { receivedTurnId = resolve; });
    let finalText: string | undefined;
    let legacyText: string | undefined;
    let planText: string | undefined;
    let failure: Error | undefined;
    let resolveResult!: (result: AgentResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<AgentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // A transport fault can precede the handshake; retain it without an unhandled rejection.
    void result.catch(() => undefined);
    const fail = (error: Error) => {
      failure ??= error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      rejectResult(error);
    };
    const captureItem = (value: unknown) => {
      const item = record(value);
      if (item?.type === 'agentMessage') {
        if (item.phase === 'final_answer') finalText = text(item.text);
        else if (!item.phase) legacyText = text(item.text);
      }
      if (item?.type === 'plan') planText = text(item.text);
    };
    let process: JsonProcess | undefined;
    try {
      process = new JsonProcess({
        executable: this.executable, args: [...this.prefixArgs, 'app-server', ...Object.keys(isolatedFeatures).flatMap(feature => ['--disable', feature])], cwd: workingDirectory, signal: request.signal,
        onFault: fail,
        onRecord: (value) => {
          const frame = record(value);
          if (!frame) return;
          if (typeof frame.method === 'string' && frame.id !== undefined) {
            // The hardcoded workflow does not auto-grant tool escalation or user input.
            if (frame.method === 'item/commandExecution/requestApproval' || frame.method === 'item/fileChange/requestApproval') {
              process?.send({ id: frame.id, result: { decision: bypassPermissions ? 'accept' : 'decline' } });
              if (bypassPermissions) return;
            } else if (frame.method === 'item/permissions/requestApproval') {
              process?.send({ id: frame.id, result: { permissions: {}, scope: 'turn' } });
              if (bypassPermissions) return;
            } else if (frame.method === 'mcpServer/elicitation/request') {
              process?.send({ id: frame.id, result: { action: 'decline', content: null } });
            } else {
              process?.send({ id: frame.id, error: { code: -32601, message: 'Muon requires owner attention for this request.' } });
            }
            fail(new Error(`Codex requires owner attention (${frame.method}).`));
            return;
          }
          if (typeof frame.id === 'number') {
            const waiter = pending.get(frame.id);
            if (!waiter) return;
            pending.delete(frame.id);
            if (frame.error) waiter.reject(new Error(errorMessage(frame.error, 'Codex request failed.')));
            else waiter.resolve(frame.result);
            return;
          }
          const params = record(frame.params);
          if (!params || params.threadId !== sessionId || !sessionId) return;
          if (frame.method === 'turn/started') {
            turnId = text(record(params.turn)?.id) ?? turnId;
            if (turnId) receivedTurnId(turnId);
          }
          if (turnId && params.turnId && params.turnId !== turnId) return;
          if (frame.method === 'item/completed') captureItem(params.item);
          if (frame.method !== 'turn/completed') return;
          const turn = record(params.turn);
          if (!turn || (turnId && turn.id !== turnId)) return;
          if (turn.status !== 'completed') {
            fail(new Error(errorMessage(turn.error, `Codex turn ${String(turn.status ?? 'failed')}.`)));
            return;
          }
          if (Array.isArray(turn.items)) turn.items.forEach(captureItem);
          const answer = (request.phase === 'planning' ? planText : undefined) ?? finalText ?? legacyText;
          if (!answer) { fail(new Error('Codex completed without a final result.')); return; }
          resolveResult({ text: answer, sessionId });
        },
      });
      const connection = process;
      const rpc = (method: string, params: Record<string, unknown>): Promise<unknown> => {
        if (failure) return Promise.reject(failure);
        const id = nextRequestId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Codex ${method} timed out.`));
          }, 60_000);
          pending.set(id, {
            resolve: (value) => { clearTimeout(timer); resolve(value); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          });
          try { connection.send({ id, method, params }); } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        });
      };
      await rpc('initialize', {
        clientInfo: { name: 'muon', title: 'Muon', version: '0.1.0' },
      });
      connection.send({ method: 'initialized' });
      // Empty MCP tables merge with user/project config; disable each effective server explicitly.
      // Read only configuration in memory: never rewrite the owner's config or credentials.
      const configuration = record(record(await rpc('config/read', { cwd: workingDirectory, includeLayers: false }))?.config);
      if (!configuration) throw new Error('Codex could not resolve isolated task configuration. Use the app-managed CLI.');
      const mcpServers = Object.fromEntries(Object.keys(record(configuration.mcp_servers) ?? {}).map(name => [name, { enabled: false }]));
      // Quick chats and the chief may pick their own model; task phases keep the configured one.
      const model = request.phase === 'chat' || chief ? request.model ?? this.model : this.model;
      const reasoningEffort = chat ? request.effort ?? this.reasoningEffort : this.reasoningEffort;
      const config = { mcp_servers: mcpServers, features: isolatedFeatures,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
      };
      const opened = record(await rpc(request.sessionId ? 'thread/resume' : 'thread/start', {
        ...(request.sessionId ? { threadId: request.sessionId } : {}),
        cwd: workingDirectory, approvalPolicy: 'never', sandbox: bypassPermissions ? 'danger-full-access' : readonly ? 'read-only' : 'workspace-write',
        config,
      }));
      sessionId = text(record(opened?.thread)?.id);
      if (!sessionId || /\s/.test(sessionId) || (request.sessionId && request.sessionId !== sessionId)) {
        throw new Error('Codex did not confirm the requested session identity.');
      }
      if (failure) throw failure;
      request.onSessionId?.(sessionId);
      const started = record(await rpc('turn/start', {
        threadId: sessionId,
        input: [{ type: 'text', text: prompt }],
        cwd: workingDirectory,
        approvalPolicy: 'never',
        sandboxPolicy: bypassPermissions
          ? { type: 'dangerFullAccess' }
          : readonly
          ? { type: 'readOnly' }
          : { type: 'workspaceWrite', writableRoots: [workingDirectory], networkAccess: !chat },
      }));
      turnId = text(record(started?.turn)?.id) ?? turnId;
      if (!turnId) {
        // Older app-servers acknowledge before the turn ID arrives (Orca turn-start contract).
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          turnId = await Promise.race([
            turnIdentity,
            result.then(() => { throw new Error('Codex completed without confirming a turn identity.'); }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Codex did not confirm a turn identity.')), 10_000);
            }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      }
      return await result;
    } finally {
      fail(new Error('Codex connection closed.'));
      await process?.stop();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
}
