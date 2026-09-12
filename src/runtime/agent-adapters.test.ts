import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CodexAdapter } from './codex-adapter.js';

let directory: string;
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'muon-runtime-'))); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function executable(name: string, source: string): Promise<string> {
  const path = join(directory, `${name}.mjs`);
  await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  return path;
}

async function claudeFixture(): Promise<string> {
  return executable('claude', `
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('2.1.258'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8').on('data', data => prompt += data).on('end', () => {
  writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), prompt, chiefToken: process.env.MUON_API_TOKEN }));
  if (prompt === 'crash') { process.stderr.write('Please sign in first'); process.exit(1); }
  if (prompt === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
  if (prompt === 'malformed') { console.log('broken JSON'); return; }
  if (prompt === 'error') { console.log(JSON.stringify({type:'result',is_error:true,result:'Test command denied'})); return; }
  const resumeIndex = process.argv.indexOf('--resume');
  const sessionId = resumeIndex < 0 ? 'claude-session' : process.argv[resumeIndex + 1];
  const confirmedId = prompt === 'wrong-session' ? 'another-session' : prompt === 'invalid-session' ? ' ' : sessionId;
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:confirmedId}));
  if (prompt === 'session-hang') { setInterval(() => {}, 1000); return; }
  if (prompt === 'session-error') { console.log(JSON.stringify({type:'result',is_error:true,result:'Provider unavailable',session_id:sessionId})); return; }
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'private'},{type:'tool_use',name:'Read',input:{file_path:'src/project.ts'}},{type:'text',text:'Working...'}]}}));
  const result = Buffer.from(JSON.stringify({type:'result',subtype:'success',result:'Finished ✓',session_id:prompt === 'changed-session' ? 'another-session' : sessionId}) + '\\n');
  const split = result.indexOf(Buffer.from('✓')) + 1;
  process.stdout.write(result.subarray(0, split));
  setTimeout(() => process.stdout.write(result.subarray(split)), 5);
});
`);
}

async function codexFixture(options: { sessionId?: unknown } = {}): Promise<string> {
  return executable('codex', `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex 1.0'); process.exit(0); }
writeFileSync('codex-invocation.json', JSON.stringify({args:process.argv.slice(2)}));
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const options = ${JSON.stringify(options)};
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
  const frame = JSON.parse(line);
  appendFileSync('requests.jsonl', line + '\\n');
  if (!frame.method) return;
  if (frame.method === 'initialize') send({id:frame.id,result:{}});
  if (frame.method === 'config/read') send({id:frame.id,result:{config:{model:'configured-model',mcp_servers:{'personal-tools':{command:'tool-server'},'project.tools':{url:'https://example.invalid/mcp'}}}}});
  if (frame.method === 'thread/start' || frame.method === 'thread/resume') send({id:frame.id,result:{thread:{id:Object.hasOwn(options, 'sessionId') ? options.sessionId : frame.params.threadId ?? 'codex-thread'}}});
  if (frame.method === 'turn/start') {
    const threadId = frame.params.threadId;
    const prompt = frame.params.input[0].text;
    send({id:frame.id,result:prompt === 'deferred-id' ? {} : {turn:{id:'turn-1',status:'inProgress'}}});
    setTimeout(() => {
      if (prompt === 'permission') send({id:900,method:'item/commandExecution/requestApproval',params:{threadId,turnId:'turn-1'}});
      if (prompt === 'permissions') send({id:901,method:'item/permissions/requestApproval',params:{threadId,turnId:'turn-1'}});
      const event = (method, params) => send({method,params:{threadId,turnId:'turn-1',...params}});
      event('turn/started',{turn:{id:'turn-1'}});
      send({method:'turn/completed',params:{threadId:'someone-else',turn:{id:'other',status:'failed'}}});
      event('item/completed',{item:{type:'reasoning',text:'secret'}});
      event('item/completed',{item:{type:'agentMessage',text:'In progress',phase:'commentary'}});
      if (prompt === 'plan') event('item/completed',{item:{type:'plan',text:'# RFC\\nProposed change'}});
      else event('item/completed',{item:{type:'agentMessage',text:'Final result',...(prompt === 'legacy' ? {} : {phase:'final_answer'})}});
      event('turn/completed',{turn:{id:'turn-1',status:prompt === 'fail' ? 'failed' : 'completed',error:prompt === 'fail' ? {message:'Provider unavailable'} : null}});
    }, 5);
  }
});
lines.on('close', () => process.exit(0));
`);
}

describe('ClaudeCodeAdapter', () => {
  it('lets the chief invoke only its scoped CLI with a read-only repository and no credential in arguments', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    const command = `'${join(directory, 'muon')}'`;
    const token = 'fixture-only-token';
    await adapter.run({ provider: 'claude', phase: 'chief', cwd: directory, prompt: 'Manage tasks through the CLI', chiefCli: { command, apiUrl: 'http://127.0.0.1:4310', token } });
    const invocation = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'));
    const { args } = invocation;
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Bash');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(settings.permissions.allow).toEqual([`Bash(${join(directory, 'muon')} *)`]);
    expect(settings.permissions.deny).toContain('Write');
    expect(settings.permissions.deny).toContain('Edit');
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, network: { allowedDomains: ['127.0.0.1:4310'], allowLocalBinding: false, strictAllowlist: true } });
    expect(settings.sandbox.filesystem.denyWrite).toContain(directory);
    expect(invocation.chiefToken).toBe(token);
    expect(JSON.stringify(args)).not.toContain(token);
    expect(invocation.prompt).not.toContain(token);
  });

  it('requires a chief CLI capability instead of falling back to unrestricted shell access', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    await expect(adapter.run({ provider: 'claude', phase: 'chief', cwd: directory, prompt: 'Manage tasks' })).rejects.toThrow('scoped Muon CLI session');
  });
  it('selects the chief model per request while preserving its scope and defaults for other phases', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture(), { model: 'configured-model', effort: 'max', bypassPermissions: true });
    const chiefCli = { command: join(directory, 'muon'), apiUrl: 'http://127.0.0.1:4310', token: 'fixture-token' };
    await adapter.run({ provider: 'claude', phase: 'chief', cwd: directory, prompt: 'Manage tasks', model: 'sonnet[1m]', chiefCli });
    let { args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'));
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet[1m]');
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
    expect(args).toContain('--restricted');
    expect(args).not.toContain('--dangerously-skip-permissions');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.permissions.allow).toEqual([`Bash(${chiefCli.command} *)`]);
    expect(settings.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
    await adapter.run({ provider: 'claude', phase: 'chief', cwd: directory, prompt: 'Use the default', chiefCli });
    ({ args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8')));
    expect(args[args.indexOf('--model') + 1]).toBe('configured-model');
    await adapter.run({ provider: 'claude', phase: 'planning', cwd: directory, prompt: 'Make a plan', model: 'chief-only-model' });
    ({ args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8')));
    expect(args[args.indexOf('--model') + 1]).toBe('configured-model');
  });
  it('returns only the final result and frames split UTF-8 correctly', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    expect(await adapter.available()).toBe(true);
    await expect(adapter.run({ provider: 'claude', phase: 'planning', cwd: directory, prompt: 'Make a plan' })).resolves.toEqual({ text: 'Finished ✓', sessionId: 'claude-session' });
    const invocation = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'));
    expect(invocation.prompt).toBe('Make a plan');
    expect(invocation.args).toContain('--restricted');
    expect(invocation.args).toContain('--strict-mcp-config');
    expect(invocation.args[invocation.args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(invocation.args[invocation.args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(invocation.args[invocation.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    expect(JSON.parse(invocation.args[invocation.args.indexOf('--settings') + 1]).sandbox.network).toEqual({ allowedDomains: [], allowLocalBinding: false });
  });

  it('reports the chief tool action currently being performed', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    const progress: string[] = [];
    await adapter.run({ provider: 'claude', phase: 'chief', cwd: directory, prompt: 'Manage tasks', onProgress: message => progress.push(message), chiefCli: { command: join(directory, 'muon'), apiUrl: 'http://127.0.0.1:4310', token: 'fixture-token' } });
    expect(progress).toContain('Reading src/project.ts');
  });

  it('confines building and verification without bypassing permissions', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    await adapter.run({ provider: 'claude', phase: 'building', cwd: directory, prompt: 'Build', sessionId: 'prior-session' });
    const { args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'));
    expect(args[args.indexOf('--resume') + 1]).toBe('prior-session');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.sandbox.network).toEqual({ allowedDomains: ['registry.npmjs.org'], allowLocalBinding: false });
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, excludedCommands: [] });
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
  it('supports explicit full-access task execution when enabled', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture(), { bypassPermissions: true });
    await adapter.run({ provider: 'claude', phase: 'planning', cwd: directory, prompt: 'Research' });
    const { args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'));
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--restricted');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write,Bash');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({ disableAllHooks: true, sandbox: { enabled: false, allowUnsandboxedCommands: true } });
  });

  it.each([['error', 'Test command denied'], ['crash', 'Please sign in'], ['malformed', 'Invalid agent protocol']])('surfaces %s without accepting partial output', async (prompt, message) => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    await expect(adapter.run({ provider: 'claude', phase: 'planning', cwd: directory, prompt })).rejects.toThrow(message);
  });

  it('applies explicit owner network options only to approved execution phases', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture(), { allowedNetworkDomains: ['registry.npmjs.org', '*.example.com'], allowLocalBinding: true });
    await adapter.run({ provider: 'claude', phase: 'verification', cwd: directory, prompt: 'Check' });
    let { args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'));
    expect(JSON.parse(args[args.indexOf('--settings') + 1]).sandbox.network).toEqual({ allowedDomains: ['registry.npmjs.org', '*.example.com'], allowLocalBinding: true });
    await adapter.run({ provider: 'claude', phase: 'planning', cwd: directory, prompt: 'Plan' });
    ({ args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8')));
    expect(JSON.parse(args[args.indexOf('--settings') + 1]).sandbox.network).toEqual({ allowedDomains: [], allowLocalBinding: false });
    expect(() => new ClaudeCodeAdapter('claude', { allowedNetworkDomains: ['*'] })).toThrow('host names');
    expect(() => new ClaudeCodeAdapter('claude', { allowedNetworkDomains: ['https://registry.npmjs.org'] })).toThrow('host names');
  });

  it('cancels and reaps a process that ignores graceful termination', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    const controller = new AbortController();
    const run = adapter.run({ provider: 'claude', phase: 'planning', cwd: directory, prompt: 'hang', signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports missing binaries as unavailable', async () => {
    expect(await new ClaudeCodeAdapter(join(directory, 'missing')).available()).toBe(false);
  });

  it.each([false, true])('reports the live session before interruption with bypassPermissions=%s', async bypassPermissions => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture(), { bypassPermissions });
    const controller = new AbortController();
    const sessions: string[] = [];
    await expect(adapter.run({ provider: 'claude', phase: 'planning', cwd: directory, prompt: 'session-hang', signal: controller.signal, onSessionId: sessionId => {
      sessions.push(sessionId);
      controller.abort();
    } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sessions).toEqual(['claude-session']);
  });

  it.each([false, true])('reports confirmed resumed sessions once, including failed turns, with bypassPermissions=%s', async bypassPermissions => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture(), { bypassPermissions });
    const sessions: string[] = [];
    const request = { provider: 'claude' as const, phase: 'building' as const, cwd: directory, sessionId: 'saved-session', onSessionId: (sessionId: string) => { sessions.push(sessionId); } };
    await expect(adapter.run({ ...request, prompt: 'Build' })).resolves.toMatchObject({ sessionId: 'saved-session' });
    expect(sessions).toEqual(['saved-session']);
    sessions.length = 0;
    await expect(adapter.run({ ...request, prompt: 'session-error' })).rejects.toThrow('Provider unavailable');
    expect(sessions).toEqual(['saved-session']);
  });

  it.each([false, true])('rejects invalid or changed provider identities with bypassPermissions=%s', async bypassPermissions => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture(), { bypassPermissions });
    for (const prompt of ['wrong-session', 'invalid-session', 'changed-session']) {
      const sessions: string[] = [];
      await expect(adapter.run({ provider: 'claude', phase: 'building', cwd: directory, sessionId: 'saved-session', prompt, onSessionId: sessionId => { sessions.push(sessionId); } })).rejects.toThrow('stable session identity');
      expect(sessions).toEqual(prompt === 'changed-session' ? ['saved-session'] : []);
    }
  });

  it('keeps resumed discussion read-only even when full-access execution is configured', async () => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture(), { bypassPermissions: true, allowLocalBinding: true });
    await adapter.run({ provider: 'claude', phase: 'discussion', cwd: directory, prompt: 'Explain the completed work', sessionId: 'saved-session' });
    const { args } = JSON.parse(await readFile(join(directory, 'invocation.json'), 'utf8'));
    expect(args).toContain('--restricted');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--resume') + 1]).toBe('saved-session');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.permissions).toMatchObject({ disableBypassPermissionsMode: 'disable', deny: ['Edit', 'Write', 'Bash'] });
    expect(settings.sandbox).toMatchObject({ allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, network: { allowedDomains: [], allowLocalBinding: false } });
  });
});

describe('CodexAdapter', () => {
  it('performs the app-server handshake, resumes sessions, and hides intermediate output', async () => {
    const adapter = new CodexAdapter(await codexFixture());
    expect(await adapter.available()).toBe(true);
    await expect(adapter.run({ provider: 'codex', phase: 'building', cwd: directory, prompt: 'Build', sessionId: 'saved-thread' })).resolves.toEqual({ text: 'Final result', sessionId: 'saved-thread' });
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.map((entry) => entry.method)).toEqual(['initialize', 'initialized', 'config/read', 'thread/resume', 'turn/start']);
    expect(requests[2].params).toEqual({ cwd: directory, includeLayers: false });
    expect(requests[3].params.config).toEqual({ mcp_servers: { 'personal-tools': { enabled: false }, 'project.tools': { enabled: false } }, features: { apps: false, plugins: false, hooks: false, multi_agent: false } });
    expect(requests[3].params.config.model).toBeUndefined();
    expect(requests[4].params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [directory], networkAccess: true } });
    const { args } = JSON.parse(await readFile(join(directory, 'codex-invocation.json'), 'utf8'));
    expect(args).toEqual(['app-server', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'multi_agent']);
  });

  it('returns authoritative RFC plan items with read-only permissions', async () => {
    const adapter = new CodexAdapter(await codexFixture());
    await expect(adapter.run({ provider: 'codex', phase: 'planning', cwd: directory, prompt: 'plan' })).resolves.toMatchObject({ text: '# RFC\nProposed change' });
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests[3].params.sandbox).toBe('read-only');
    expect(requests[3].params.config.mcp_servers['personal-tools'].enabled).toBe(false);
    expect(requests[4].params.sandboxPolicy).toEqual({ type: 'readOnly' });
  });
  it('uses danger-full-access policies when explicitly enabled', async () => {
    const adapter = new CodexAdapter(await codexFixture(), { bypassPermissions: true });
    await adapter.run({ provider: 'codex', phase: 'building', cwd: directory, prompt: 'Build' });
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests[3].params.sandbox).toBe('danger-full-access');
    expect(requests[4].params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
  });
  it('does not abort full-access runs on provider permission requests', async () => {
    const adapter = new CodexAdapter(await codexFixture(), { bypassPermissions: true });
    await expect(adapter.run({ provider: 'codex', phase: 'building', cwd: directory, prompt: 'permissions' })).resolves.toMatchObject({ text: 'Final result' });
  });

  it('accepts legacy completed messages without phase metadata', async () => {
    const adapter = new CodexAdapter(await codexFixture());
    await expect(adapter.run({ provider: 'codex', phase: 'verification', cwd: directory, prompt: 'legacy' })).resolves.toMatchObject({ text: 'Final result' });
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.at(-1).params.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: [directory], networkAccess: true });
  });

  it('waits for a turn ID delivered after the turn/start acknowledgement', async () => {
    const adapter = new CodexAdapter(await codexFixture());
    await expect(adapter.run({ provider: 'codex', phase: 'building', cwd: directory, prompt: 'deferred-id' })).resolves.toMatchObject({ text: 'Final result' });
  });

  it.each([['fail', 'Provider unavailable'], ['permission', 'requires owner attention']])('surfaces %s as a failure', async (prompt, message) => {
    const adapter = new CodexAdapter(await codexFixture());
    await expect(adapter.run({ provider: 'codex', phase: 'building', cwd: directory, prompt })).rejects.toThrow(message);
  });

  it('reports the new thread before interruption and does not start a turn after abort', async () => {
    const adapter = new CodexAdapter(await codexFixture());
    const controller = new AbortController();
    const sessions: string[] = [];
    await expect(adapter.run({ provider: 'codex', phase: 'planning', cwd: directory, prompt: 'Plan', signal: controller.signal, onSessionId: sessionId => {
      sessions.push(sessionId);
      controller.abort();
    } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sessions).toEqual(['codex-thread']);
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.some(entry => entry.method === 'turn/start')).toBe(false);
  });

  it('reports confirmed resumed sessions once, including failed turns', async () => {
    const adapter = new CodexAdapter(await codexFixture());
    const sessions: string[] = [];
    const request = { provider: 'codex' as const, phase: 'building' as const, cwd: directory, sessionId: 'saved-thread', onSessionId: (sessionId: string) => { sessions.push(sessionId); } };
    await expect(adapter.run({ ...request, prompt: 'Build' })).resolves.toMatchObject({ sessionId: 'saved-thread' });
    expect(sessions).toEqual(['saved-thread']);
    sessions.length = 0;
    await expect(adapter.run({ ...request, prompt: 'fail' })).rejects.toThrow('Provider unavailable');
    expect(sessions).toEqual(['saved-thread']);
  });

  it.each(['another-thread', '', ' ', 12])('rejects an unconfirmed resumed identity %j before notifying or starting a turn', async sessionId => {
    const adapter = new CodexAdapter(await codexFixture({ sessionId }));
    const sessions: string[] = [];
    await expect(adapter.run({ provider: 'codex', phase: 'building', cwd: directory, prompt: 'Build', sessionId: 'saved-thread', onSessionId: confirmed => { sessions.push(confirmed); } })).rejects.toThrow('requested session identity');
    expect(sessions).toEqual([]);
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.some(entry => entry.method === 'turn/start')).toBe(false);
  });

  it('keeps resumed discussion read-only even when full-access execution is configured', async () => {
    const adapter = new CodexAdapter(await codexFixture(), { bypassPermissions: true });
    await adapter.run({ provider: 'codex', phase: 'discussion', cwd: directory, prompt: 'Explain the completed work', sessionId: 'saved-thread' });
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.find(entry => entry.method === 'thread/resume').params).toMatchObject({ threadId: 'saved-thread', approvalPolicy: 'never', sandbox: 'read-only' });
    expect(requests.find(entry => entry.method === 'turn/start').params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
  });

  it.each(['permission', 'permissions'])('declines discussion %s requests even when full-access execution is configured', async prompt => {
    const adapter = new CodexAdapter(await codexFixture(), { bypassPermissions: true });
    await expect(adapter.run({ provider: 'codex', phase: 'discussion', cwd: directory, prompt })).rejects.toThrow('requires owner attention');
    const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.find(entry => entry.id === (prompt === 'permission' ? 900 : 901)).result).toEqual(prompt === 'permission' ? { decision: 'decline' } : { permissions: {}, scope: 'turn' });
  });
});
