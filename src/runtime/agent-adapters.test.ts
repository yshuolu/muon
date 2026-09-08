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
  writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), prompt }));
  if (prompt === 'crash') { process.stderr.write('Please sign in first'); process.exit(1); }
  if (prompt === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
  if (prompt === 'malformed') { console.log('broken JSON'); return; }
  if (prompt === 'error') { console.log(JSON.stringify({type:'result',is_error:true,result:'Test command denied'})); return; }
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-session'}));
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'private'},{type:'text',text:'Working...'}]}}));
  const result = Buffer.from(JSON.stringify({type:'result',subtype:'success',result:'Finished ✓',session_id:'claude-session'}) + '\\n');
  const split = result.indexOf(Buffer.from('✓')) + 1;
  process.stdout.write(result.subarray(0, split));
  setTimeout(() => process.stdout.write(result.subarray(split)), 5);
});
`);
}

async function codexFixture(): Promise<string> {
  return executable('codex', `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex 1.0'); process.exit(0); }
writeFileSync('codex-invocation.json', JSON.stringify({args:process.argv.slice(2)}));
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
  const frame = JSON.parse(line);
  appendFileSync('requests.jsonl', line + '\\n');
  if (!frame.method) return;
  if (frame.method === 'initialize') send({id:frame.id,result:{}});
  if (frame.method === 'config/read') send({id:frame.id,result:{config:{model:'configured-model',mcp_servers:{'personal-tools':{command:'tool-server'},'project.tools':{url:'https://example.invalid/mcp'}}}}});
  if (frame.method === 'thread/start' || frame.method === 'thread/resume') send({id:frame.id,result:{thread:{id:frame.params.threadId ?? 'codex-thread'}}});
  if (frame.method === 'turn/start') {
    const threadId = frame.params.threadId;
    const prompt = frame.params.input[0].text;
    send({id:frame.id,result:prompt === 'deferred-id' ? {} : {turn:{id:'turn-1',status:'inProgress'}}});
    setTimeout(() => {
      if (prompt === 'permission') { send({id:900,method:'item/commandExecution/requestApproval',params:{threadId,turnId:'turn-1'}}); return; }
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

  it.each([['error', 'Test command denied'], ['crash', 'Please sign in'], ['malformed', 'Invalid agent protocol']])('surfaces %s without accepting partial output', async (prompt, message) => {
    const adapter = new ClaudeCodeAdapter(await claudeFixture());
    await expect(adapter.run({ provider: 'claude', phase: 'chief', cwd: directory, prompt })).rejects.toThrow(message);
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
});
