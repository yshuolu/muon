import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApiClient, ApiError } from '../shared/api-client';
import { taskCommentSchema } from '../shared/api-contract';

export const CLI_HELP = `Muon — task system REST client

Usage: muon <resource> <command> [arguments] [options]

  health | state | project | runtime
  settings [get] | settings update --json <object>
  tasks list [--status todo] [--provider claude] [--kind group]
             [--parent <id>] [--blocked-by <id>] [--search <text>]
  tasks get <id>
  tasks create --json <object>
  tasks update <id> --json <object>
  tasks cancel <id>
  tasks retry <id> [--mode retry|fix|replan] [--feedback <text>]
  tasks approve <id> --plan-id <exact-plan-id>
  tasks discussion <id>
  tasks comments <id>
  tasks comment <id> --json '{"requestId":"UUID","content":"...","mode":"message"}'
  tasks retry-comments <id>
  tasks comment <id> --plan-id <id> --content <text>
  tasks request-changes <id> --plan-id <id> --feedback <text>
  tasks plans|evidence|files|activity|runs|subtasks|dependencies <id>
  tasks plan <id> <plan-id> [--output <path|->]
  tasks dependency-patch <id> <plan-id> <dependency-id> --output <path|->
  attention [list] [--unread] | attention read <id>
  chief messages | chief send --json '{"content":"..."}'
  artifacts download <id> --output <path|->
  api <METHOD> /api/<path> [--json <object>] [--output <path|->]

Task references accept UUIDs or identifiers such as MUO-12.
JSON bodies: --json '{...}', --file body.json, or --file - for stdin.
JSON is the default output; downloads use --output (- writes raw bytes).
MUON_API_URL defaults to http://127.0.0.1:4310. MUON_API_TOKEN is read
only from the environment. The CLI never reads or writes the database.
`;

interface ParsedArgs { words: string[]; flags: Map<string, string | boolean> }
const BOOLEAN_FLAGS = new Set(['help', 'unread']);
const fail = (message: string): never => { throw new ApiError(message, 0, 'invalid_arguments'); };
function parseArgs(args: string[]): ParsedArgs {
  const words: string[] = []; const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h') { flags.set('help', true); continue; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const separator = arg.indexOf('=');
    const key = arg.slice(2, separator < 0 ? undefined : separator);
    if (!key || flags.has(key)) fail(`Invalid or duplicate option: --${key}`);
    if (BOOLEAN_FLAGS.has(key)) { if (separator >= 0) fail(`--${key} does not take a value.`); flags.set(key, true); continue; }
    const value = separator >= 0 ? arg.slice(separator + 1) : args[++i];
    if (value === undefined || value.startsWith('--')) fail(`--${key} requires a value.`);
    flags.set(key, value);
  }
  return { words, flags };
}

export interface CliIO {
  stdout: (text: string | Uint8Array) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof globalThis.fetch;
}

/** Run one CLI command. Return an exit code without terminating the embedding process. */
export async function runCli(args: string[], io: CliIO): Promise<number> {
  try {
    const { words, flags } = parseArgs(args);
    if (!words.length || flags.has('help') || words[0] === 'help') { io.stdout(CLI_HELP); return 0; }
    const allowed = new Set<string>();
    const option = (name: string): string | undefined => { allowed.add(name); const value = flags.get(name); return typeof value === 'string' ? value : undefined; };
    const required = (name: string): string => option(name) || fail(`--${name} is required.`);
    const checkFlags = () => { for (const key of flags.keys()) if (!allowed.has(key)) fail(`Unknown option: --${key}`); };
    const expect = (length: number) => { if (words.length !== length) fail('Incorrect arguments. Run muon --help for usage.'); };
    const id = (value: string | undefined): string => value ? encodeURIComponent(value) : fail('A record ID is required.');
    const readBody = async (requiredBody = true): Promise<Record<string, unknown> | undefined> => {
      const json = option('json'); const file = option('file');
      if (json !== undefined && file !== undefined) fail('Choose either --json or --file.');
      if (json === undefined && file === undefined) { if (requiredBody) fail('A JSON body is required (--json or --file).'); return undefined; }
      let source: string;
      try { source = json ?? (file === '-' ? await io.stdin() : await readFile(resolve(io.cwd, file!), 'utf8')); }
      catch { return fail('Unable to read the JSON input file.'); }
      let parsed: unknown;
      try { parsed = JSON.parse(source); } catch { return fail('The request body must contain valid JSON.'); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('The request body must be a JSON object.');
      return parsed as Record<string, unknown>;
    };
    let path = ''; let method = 'GET'; let body: unknown; let output: string | undefined; let planExport = false;
    const [resource, command, recordId] = words;
    if (['health', 'state', 'project', 'runtime'].includes(resource)) { expect(1); path = `/api/${resource}`; }
    else if (resource === 'settings') {
      if (!command || command === 'get') { expect(command ? 2 : 1); path = '/api/settings'; }
      else if (command === 'update') { expect(2); path = '/api/settings'; method = 'PATCH'; body = await readBody(); }
      else fail('Unknown settings command.');
    } else if (resource === 'tasks') {
      if (!command || command === 'list') {
        expect(command ? 2 : 1); const query = new URLSearchParams();
        for (const [flag, key] of Object.entries({ status: 'status', provider: 'provider', kind: 'kind', parent: 'parentId', 'blocked-by': 'blockedById', search: 'search' })) {
          const value = option(flag); if (value !== undefined) query.set(key, value);
        }
        path = '/api/tasks' + (query.size ? `?${query}` : '');
      } else if (command === 'create') { expect(2); path = '/api/tasks'; method = 'POST'; body = await readBody(); }
      else if (command === 'get') { expect(3); path = `/api/tasks/${id(recordId)}`; }
      else if (command === 'update') { expect(3); path = `/api/tasks/${id(recordId)}`; method = 'PATCH'; body = await readBody(); }
      else if (command === 'comment') {
        expect(3); method = 'POST';
        const input = await readBody(false) ?? {};
        for (const [flag, key] of Object.entries({ 'plan-id': 'planId', 'request-id': 'requestId', content: 'content', mode: 'mode' })) {
          const value = option(flag);
          if (value !== undefined) {
            if (key in input) fail(`Specify ${key} in the body or as an option, not both.`);
            input[key] = value;
          }
        }
        if ('planId' in input) {
          if (typeof input.planId !== 'string' || !input.planId.trim()) fail('The exact plan ID is required (--plan-id).');
          if (typeof input.content !== 'string' || !input.content.trim()) fail('A plan discussion comment is required (--content).');
          if ('requestId' in input || 'mode' in input) fail('RFC review comments cannot include task follow-up options.');
          path = `/api/tasks/${id(recordId)}/plan-discussion`;
          body = input;
        } else {
          const parsed = taskCommentSchema.safeParse(input);
          if (!parsed.success) fail(`Invalid task comment: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
          path = `/api/tasks/${id(recordId)}/comments`;
          body = parsed.data;
        }
      } else if (['cancel', 'retry', 'retry-comments', 'approve', 'request-changes'].includes(command)) {
        expect(3); path = `/api/tasks/${id(recordId)}/${command === 'retry-comments' ? 'comments/retry' : command}`; method = 'POST';
        const input = await readBody(false) ?? {};
        for (const [flag, key] of Object.entries(command === 'retry' ? { mode: 'mode', feedback: 'feedback' } : command === 'request-changes' ? { 'plan-id': 'planId', feedback: 'feedback' } : command === 'approve' ? { 'plan-id': 'planId' } : {})) {
          const value = option(flag); if (value !== undefined) { if (key in input) fail(`Specify ${key} in the body or as an option, not both.`); input[key] = value; }
        }
        if (['approve', 'request-changes'].includes(command) && (typeof input.planId !== 'string' || !input.planId.trim())) fail('The exact plan ID is required (--plan-id).');
        if (command === 'request-changes' && (typeof input.feedback !== 'string' || !input.feedback.trim())) fail('Review feedback is required (--feedback).');
        body = input;
      } else if (command === 'plan') { expect(4); path = `/api/tasks/${id(recordId)}/plans/${id(words[3])}`; output = option('output'); planExport = output !== undefined; }
      else if (command === 'dependency-patch') { expect(5); path = `/api/tasks/${id(recordId)}/plans/${id(words[3])}/dependencies/${id(words[4])}/patch`; output = required('output'); }
      else {
        const resources = ['plans', 'evidence', 'files', 'activity', 'runs', 'subtasks', 'dependencies', 'discussion', 'comments'];
        expect(3);
        if (resources.includes(command)) path = `/api/tasks/${id(recordId)}/${command === 'discussion' ? 'plan-discussion' : command}`;
        else if (resources.includes(recordId)) path = `/api/tasks/${id(command)}/${recordId === 'discussion' ? 'plan-discussion' : recordId}`;
        else fail('Unknown tasks command.');
      }
    } else if (resource === 'attention') {
      if (!command || command === 'list') { expect(command ? 2 : 1); allowed.add('unread'); path = '/api/attention' + (flags.has('unread') ? '?unread=true' : ''); }
      else if (command === 'read') { expect(3); path = `/api/attention/${id(recordId)}/read`; method = 'POST'; body = {}; }
      else fail('Unknown attention command.');
    } else if (resource === 'chief') {
      expect(2); path = '/api/chief/messages';
      if (command === 'send') { method = 'POST'; body = await readBody(); }
      else if (command !== 'messages') fail('Unknown chief command.');
    } else if (resource === 'artifacts' && command === 'download') {
      expect(3); path = `/api/artifacts/${id(recordId)}`; output = required('output');
    } else if (resource === 'api') {
      expect(3); method = command.toUpperCase();
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) fail('Unsupported HTTP method.');
      if (!recordId?.startsWith('/api/')) fail('The API path must begin with /api/.');
      path = recordId; body = await readBody(false); output = option('output');
      if (output !== undefined && method !== 'GET') fail('--output is supported only for GET requests.');
      if (body !== undefined && ['GET', 'HEAD'].includes(method)) fail(`${method} requests cannot have a JSON body.`);
      if (body === undefined && !['GET', 'HEAD'].includes(method)) body = {};
    } else fail('Unknown command. Run muon --help for usage.');
    checkFlags();
    const client = new ApiClient({ baseUrl: io.env.MUON_API_URL || 'http://127.0.0.1:4310', token: io.env.MUON_API_TOKEN, fetch: io.fetch });
    if (output !== undefined) {
      const result = planExport ? await client.request<{ content: string; format: string }>(path).then(plan => {
        if (typeof plan.content !== 'string' || !['markdown', 'html'].includes(plan.format)) throw new ApiError('Muon API returned an invalid plan.', 0, 'invalid_response');
        return { data: new TextEncoder().encode(plan.content), contentType: plan.format === 'html' ? 'text/html' : 'text/markdown' };
      }) : await client.download(path);
      if (output === '-') io.stdout(result.data);
      else {
        const target = resolve(io.cwd, output);
        try { await writeFile(target, result.data, { flag: 'wx', mode: 0o600 }); }
        catch { fail('Unable to write download. The parent directory must exist and the output file must be new.'); }
        io.stdout(JSON.stringify({ path: target, bytes: result.data.byteLength, contentType: result.contentType }) + '\n');
      }
    } else io.stdout(JSON.stringify(await client.request(path, method, body)) + '\n');
    return 0;
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError('The command could not complete.', 0, 'cli_error');
    const redact = (value: string) => io.env.MUON_API_TOKEN ? value.replaceAll(io.env.MUON_API_TOKEN, '[redacted]') : value;
    const output = JSON.stringify({ error: { code: redact(apiError.code), message: redact(apiError.message), status: apiError.status } });
    io.stderr(output + '\n');
    return 1;
  }
}
