import type { AgentAdapter, AgentRequest, AgentResult } from './contracts.js';
import { JsonProcess, executableAvailable, validateWorkingDirectory } from './json-process.js';
import { record, text } from './protocol-values.js';
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
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  private readonly allowedNetworkDomains: string[];
  private readonly allowLocalBinding: boolean;
  private readonly model?: string;
  private readonly effort?: string;

  constructor(private readonly executable = 'claude', options: ClaudeCodeOptions = {}) {
    const domains = options.allowedNetworkDomains ?? ['registry.npmjs.org'];
    if (domains.length > 100 || domains.some(domain => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain))) throw new Error('Claude network allowances must be host names or *.domain patterns, with at most 100 entries.');
    this.allowedNetworkDomains = [...new Set(domains)];
    this.allowLocalBinding = options.allowLocalBinding ?? false;
    this.model = options.model;
    this.effort = options.effort;
  }

  available(): Promise<boolean> { return executableAvailable(this.executable); }

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.provider !== this.provider) throw new Error('Claude adapter received another provider.');
    await validateWorkingDirectory(request.cwd);
    const chief = request.phase === 'chief';
    const readonly = request.phase === 'planning' || request.phase === 'chat';
    if (chief && !request.chiefCli) throw new Error('The chief requires a scoped Muon CLI session.');
    const cli = request.chiefCli;
    const cliExecutable = cli?.command.replace(/^'|'$/g, '');
    if (chief && (!cliExecutable || !isAbsolute(cliExecutable) || !/^[/a-zA-Z0-9._-]+$/.test(cliExecutable))) throw new Error('The chief CLI must be an absolute executable path without shell metacharacters.');
    const api = chief ? new URL(cli!.apiUrl) : undefined;
    if (api && (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || api.username || api.password)) throw new Error('The local chief requires a loopback API endpoint.');
    const settings = {
      disableAllHooks: true,
      permissions: { disableBypassPermissionsMode: 'disable', additionalDirectories: [],
        ...(chief ? {
          allow: [`Bash(${cliExecutable} *)`],
          deny: ['Edit', 'Write', `Read(${join(request.cwd, '.muon').replace(/^\//, '//')}/**)`, 'Read(./.env)', 'Read(./.env.*)'],
        } : {}),
      },
      sandbox: {
        enabled: !readonly,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: !readonly && !chief,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        network: { allowedDomains: chief ? [api!.host] : readonly ? [] : this.allowedNetworkDomains, allowLocalBinding: !readonly && !chief && this.allowLocalBinding, ...(chief ? { strictAllowlist: true } : {}) },
        filesystem: chief ? { allowWrite: [], denyWrite: [request.cwd, dirname(cliExecutable!)], denyRead: [join(request.cwd, '.muon'), join(request.cwd, '.env')] } : { allowWrite: [request.cwd] },
      },
    };
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config',
      '--permission-mode', readonly ? 'plan' : chief ? 'default' : 'acceptEdits',
      '--permission-prompts', 'none',
      '--tools', readonly ? 'Read,Glob,Grep' : chief ? 'Read,Glob,Grep,Bash' : 'Read,Glob,Grep,Edit,Write,Bash',
      ...(this.model ? ['--model', this.model] : []),
      ...(this.effort ? ['--effort', this.effort] : []),
      '--disallowedTools', 'mcp__*',
      '--settings', JSON.stringify(settings),
      ...(request.sessionId ? ['--resume', request.sessionId] : []),
    ];
    let process: JsonProcess | undefined;
    let sessionId = request.sessionId;
    try {
      return await new Promise<AgentResult>((resolve, reject) => {
        process = new JsonProcess({
          executable: this.executable, args, cwd: request.cwd, signal: request.signal,
          ...(chief ? { env: { MUON_API_URL: cli!.apiUrl, MUON_API_TOKEN: cli!.token, MUON_CLI_SANDBOX_PROXY: '1' } } : {}),
          onFault: reject,
          onRecord: (value) => {
            const frame = record(value);
            if (!frame) return;
            sessionId = text(frame.session_id) ?? sessionId;
            const progress = progressFromFrame(frame);
            if (progress) request.onProgress?.(progress);
            if (frame.type !== 'result') return;
            if (frame.is_error === true || (frame.subtype && frame.subtype !== 'success')) {
              const errors = Array.isArray(frame.errors) ? frame.errors.filter((error) => typeof error === 'string').join('; ') : undefined;
              reject(new Error(text(frame.result) ?? errors ?? 'Claude could not complete the task.'));
              return;
            }
            const result = text(frame.result);
            if (!result) { reject(new Error('Claude returned no final result.')); return; }
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
