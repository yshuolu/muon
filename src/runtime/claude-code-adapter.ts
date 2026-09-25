import type { AgentAdapter, AgentRequest, AgentResult } from './contracts.js';
import { JsonProcess, executableAvailable, validateWorkingDirectory } from './json-process.js';
import { record, text } from './protocol-values.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';

function compact(value: unknown, limit = 140): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function progressFromFrame(frame: Record<string, unknown>): string | undefined {
  if (frame.type !== 'assistant') return undefined;
  const blocks = record(frame.message)?.content;
  if (!Array.isArray(blocks)) return undefined;
  for (const value of blocks) {
    const block = record(value);
    if (!block || block.type !== 'tool_use') continue;
    const name = text(block.name);
    const input = record(block.input);
    if (name === 'Bash') {
      const command = compact(input?.command);
      if (command) return `Running ${command}`;
    }
    if (name === 'Read') {
      const path = compact(input?.file_path);
      if (path) return `Reading ${path}`;
    }
    if (name === 'Glob') {
      const pattern = compact(input?.pattern);
      if (pattern) return `Searching for ${pattern}`;
    }
    if (name === 'Grep') {
      const pattern = compact(input?.pattern);
      const path = compact(input?.path);
      if (pattern && path) return `Searching for ${pattern} in ${path}`;
      if (pattern) return `Searching for ${pattern}`;
    }
    if (name) return `Using ${name}`;
  }
  return undefined;
}

export interface ClaudeCodeOptions {
  allowedNetworkDomains?: string[];
  allowLocalBinding?: boolean;
  model?: string;
  effort?: string;
  /** Use full local permissions except for chief requests and read-only discussions. */
  bypassPermissions?: boolean;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  private readonly allowedNetworkDomains: string[];
  private readonly allowLocalBinding: boolean;
  private readonly model?: string;
  private readonly effort?: string;
  private readonly bypassPermissions: boolean;

  constructor(private readonly executable = 'claude', options: ClaudeCodeOptions = {}) {
    const domains = options.allowedNetworkDomains ?? ['registry.npmjs.org'];
    if (domains.length > 100 || domains.some(domain => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain))) throw new Error('Claude network allowances must be host names or *.domain patterns, with at most 100 entries.');
    this.allowedNetworkDomains = [...new Set(domains)];
    this.allowLocalBinding = options.allowLocalBinding ?? false;
    this.model = options.model;
    this.effort = options.effort;
    this.bypassPermissions = options.bypassPermissions ?? false;
  }

  available(): Promise<boolean> { return executableAvailable(this.executable); }

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.provider !== this.provider) throw new Error('Claude adapter received another provider.');
    await validateWorkingDirectory(request.cwd);
    const chief = request.phase === 'chief';
    const chat = request.phase === 'chat';
    const discussion = request.phase === 'discussion';
    // The chief and planning chats work in the owner's real repository, never a task worktree:
    // they may read it and write temporary files to a scratch directory, and nothing else.
    const advisory = chief || chat;
    const model = advisory ? request.model ?? this.model : this.model;
    // Disposable chats (document reviews) may ask for a lighter effort than the configured task effort.
    const effort = chat ? request.effort ?? this.effort : this.effort;
    const readonly = request.phase === 'planning' || discussion;
    if (chief && !request.chiefCli) throw new Error('The chief requires a scoped Muon CLI session.');
    const cli = request.chiefCli;
    const cliExecutable = cli?.command.replace(/^'|'$/g, '');
    if (chief && (!cliExecutable || !isAbsolute(cliExecutable) || !/^[/a-zA-Z0-9._-]+$/.test(cliExecutable))) throw new Error('The chief CLI must be an absolute executable path without shell metacharacters.');
    const api = chief ? new URL(cli!.apiUrl) : undefined;
    if (api && (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || api.username || api.password)) throw new Error('The local chief requires a loopback API endpoint.');
    if (this.bypassPermissions && !advisory && !discussion) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--strict-mcp-config', '--permission-prompts', 'none', '--tools', 'Read,Glob,Grep,Edit,Write,Bash', ...(model ? ['--model', model] : []), ...(this.effort ? ['--effort', this.effort] : []), '--disallowedTools', 'mcp__*', '--settings', JSON.stringify({ disableAllHooks: true, sandbox: { enabled: false, allowUnsandboxedCommands: true } }), ...(request.sessionId ? ['--resume', request.sessionId] : [])];
      return this.runProcess(request, args);
    }
    const scratch = advisory ? await realpath(await mkdtemp(join(tmpdir(), 'muon-claude-scratch-'))) : undefined;
    try {
      const settings = {
        disableAllHooks: true,
        // Advisory sessions start in the scratch directory so the CLI's own state files never land in the
        // repository; the repository is attached as an additional (read-only) directory.
        permissions: { disableBypassPermissionsMode: 'disable', additionalDirectories: scratch ? [request.cwd] : [],
          ...(discussion ? { deny: ['Edit', 'Write', 'Bash'] } : {}),
          ...(chief ? { allow: [`Bash(${cliExecutable} *)`] } : {}),
          ...(advisory ? { deny: ['Edit', 'Write', `Read(${join(request.cwd, '.muon').replace(/^\//, '//')}/**)`, 'Read(./.env)', 'Read(./.env.*)'] } : {}),
        },
        sandbox: {
          enabled: !readonly,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: !readonly && !chief,
          allowUnsandboxedCommands: false,
          excludedCommands: [],
          network: { allowedDomains: chief ? [api!.host] : readonly || chat ? [] : this.allowedNetworkDomains, allowLocalBinding: !readonly && !advisory && this.allowLocalBinding, ...(chief ? { strictAllowlist: true } : {}) },
          filesystem: advisory
            ? { allowWrite: [scratch!], denyWrite: [request.cwd, ...(chief ? [dirname(cliExecutable!)] : [])], denyRead: [join(request.cwd, '.muon'), join(request.cwd, '.env')] }
            : { allowWrite: [request.cwd] },
        },
      };
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config',
        '--permission-mode', readonly ? 'plan' : advisory ? 'default' : 'acceptEdits',
        '--permission-prompts', 'none',
        '--tools', readonly ? 'Read,Glob,Grep' : advisory ? 'Read,Glob,Grep,Bash' : 'Read,Glob,Grep,Edit,Write,Bash',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        '--disallowedTools', 'mcp__*',
        '--settings', JSON.stringify(settings),
        ...(request.sessionId ? ['--resume', request.sessionId] : []),
      ];
      const prompt = scratch ? `The project repository is at ${request.cwd}. Read it with absolute paths; it is read-only for this session. Your working directory ${scratch} is a scratch folder: write any temporary files only there.\n${request.prompt}` : request.prompt;
      return await this.runProcess({ ...request, prompt, cwd: scratch ?? request.cwd }, args, chief ? { MUON_API_URL: cli!.apiUrl, MUON_API_TOKEN: cli!.token, MUON_CLI_SANDBOX_PROXY: '1' } : undefined);
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  private async runProcess(request: AgentRequest, args: string[], env?: NodeJS.ProcessEnv): Promise<AgentResult> {
    let process: JsonProcess | undefined;
    let sessionId = request.sessionId;
    let reportedSession = false;
    try {
      return await new Promise<AgentResult>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        process = new JsonProcess({
          executable: this.executable, args, cwd: request.cwd, signal: request.signal,
          ...(env ? { env } : {}),
          onFault: fail,
          onRecord: (value) => {
            const frame = record(value);
            if (!frame || settled || request.signal?.aborted) return;
            if (frame.session_id !== undefined) {
              const confirmed = text(frame.session_id);
              if (!confirmed || /\s/.test(confirmed) || (sessionId && sessionId !== confirmed)) {
                fail(new Error('Claude did not confirm a stable session identity.'));
                return;
              }
              sessionId = confirmed;
              if (!reportedSession) {
                reportedSession = true;
                request.onSessionId?.(sessionId);
              }
            }
            const progress = progressFromFrame(frame);
            if (progress) request.onProgress?.(progress);
            if (frame.type !== 'result') return;
            if (frame.is_error === true || (frame.subtype && frame.subtype !== 'success')) {
              const errors = Array.isArray(frame.errors) ? frame.errors.filter((error) => typeof error === 'string').join('; ') : undefined;
              fail(new Error(text(frame.result) ?? errors ?? 'Claude could not complete the task.'));
              return;
            }
            const result = text(frame.result);
            if (!result) { fail(new Error('Claude returned no final result.')); return; }
            settled = true;
            resolve({ text: result, ...(sessionId ? { sessionId } : {}) });
          },
        });
        process.writePrompt(request.prompt);
      });
    } finally {
      await process?.stop();
    }
  }
}
