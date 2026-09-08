import type { AgentAdapter, AgentRequest, AgentResult } from './contracts.js';
import { JsonProcess, executableAvailable, validateWorkingDirectory } from './json-process.js';
import { record, text } from './protocol-values.js';

export interface ClaudeCodeOptions {
  allowedNetworkDomains?: string[];
  allowLocalBinding?: boolean;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  private readonly allowedNetworkDomains: string[];
  private readonly allowLocalBinding: boolean;

  constructor(private readonly executable = 'claude', options: ClaudeCodeOptions = {}) {
    const domains = options.allowedNetworkDomains ?? ['registry.npmjs.org'];
    if (domains.length > 100 || domains.some(domain => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain))) throw new Error('Claude network allowances must be host names or *.domain patterns, with at most 100 entries.');
    this.allowedNetworkDomains = [...new Set(domains)];
    this.allowLocalBinding = options.allowLocalBinding ?? false;
  }

  available(): Promise<boolean> { return executableAvailable(this.executable); }

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.provider !== this.provider) throw new Error('Claude adapter received another provider.');
    await validateWorkingDirectory(request.cwd);
    const readonly = request.phase === 'planning' || request.phase === 'chief';
    const settings = {
      disableAllHooks: true,
      permissions: { disableBypassPermissionsMode: 'disable', additionalDirectories: [] },
      sandbox: {
        enabled: !readonly,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: !readonly,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        network: { allowedDomains: readonly ? [] : this.allowedNetworkDomains, allowLocalBinding: !readonly && this.allowLocalBinding },
        filesystem: { allowWrite: [request.cwd] },
      },
    };
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config',
      '--permission-mode', readonly ? 'plan' : 'acceptEdits',
      '--permission-prompts', 'none',
      '--tools', readonly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
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
          onFault: reject,
          onRecord: (value) => {
            const frame = record(value);
            if (!frame) return;
            sessionId = text(frame.session_id) ?? sessionId;
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
