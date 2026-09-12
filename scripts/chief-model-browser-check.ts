import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { LocalWorktreeProvider, type AgentAdapter, type AgentRequest, type AgentResult } from '../src/runtime';
import { createHttpApp } from '../src/server/http-app';
import { LocalArtifactStore } from '../src/server/local-artifacts';
import { LocalChiefCommands } from '../src/server/local-chief-commands';
import { SqliteRepository } from '../src/server/sqlite-repository';
import { TaskService } from '../src/server/task-service';

// Real browser, HTTP, and SQLite; controlled providers never execute project commands.
class ControlledAdapter implements AgentAdapter {
  calls: { request: AgentRequest; finish: (text: string) => void; fail: (error: Error) => void }[] = [];
  constructor(readonly provider: 'claude' | 'codex') {}
  async available() { return true; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolveRun, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Chief model fixture stopped')), { once: true });
      this.calls.push({ request, finish: text => resolveRun({ text }), fail: reject });
    });
  }
}

await mkdir(resolve('.muon/validation'), { recursive: true });
const outputRoot = await mkdtemp(resolve('.muon/validation/chief-model-'));
const repositoryPath = join(outputRoot, 'repository');
await mkdir(repositoryPath);
await writeFile(join(repositoryPath, 'README.md'), '# Chief model browser fixture\n');
const scope = { workspaceId: 'chief-model-browser', projectId: 'isolated-project', userId: 'test-owner' };
const databasePath = join(outputRoot, 'muon.sqlite');
const repository = new SqliteRepository(databasePath);
await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Chief model fixture', identifier: 'CM', repositoryPath }, { defaultProvider: 'claude', dispatcherEnabled: false, maxConcurrentAgents: 1 });
const claude = new ControlledAdapter('claude');
const codex = new ControlledAdapter('codex');
const artifacts = new LocalArtifactStore(join(outputRoot, 'artifacts'));
const port = Number(process.env.MUON_CHIEF_MODEL_BROWSER_PORT ?? 4334);
const url = `http://127.0.0.1:${port}`;
const chiefCommands = new LocalChiefCommands({ apiUrl: url, scope });
const service = new TaskService({ scope, repository, artifacts, chiefCommands, workspaces: new LocalWorktreeProvider(join(outputRoot, 'worktrees')), adapters: { claude, codex } });
await service.initialize();
service.start();
const app = createHttpApp(service, artifacts, { port, staticRoot: resolve('dist'), access: chiefCommands });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
await once(server, 'listening');
const checks: string[] = [];
const screenshots: string[] = [];
const errors: string[] = [];
const log: string[] = [`Chief model browser fixture: ${outputRoot}`];
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let succeeded = false;
function check(message: string) {
  checks.push(message);
  log.push(`PASS ${message}`);
  console.log(`PASS ${message}`);
}
async function capture(page: Page, name: string) {
  const path = join(outputRoot, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(path);
}

try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('button', { name: 'Chief of staff', exact: true }).click();
  const composer = page.locator('.chief-composer-wrap');
  const toolbar = page.locator('.chief-composer .composer-bottom');
  const modelSelect = toolbar.getByRole('combobox', { name: 'Chief of staff model', exact: true });
  const modelInput = toolbar.getByRole('textbox', { name: 'Custom Chief of staff model', exact: true });
  const sendButton = toolbar.getByRole('button', { name: 'Send message', exact: true });
  const configuredModel = (await service.snapshot()).runtime.config!.claude.model;
  const customModel = 'claude-fixture[1m]';
  await expect(modelSelect).toHaveValue(configuredModel);
  await expect(toolbar.locator('.chief-runtime-meta')).toContainText('Claude Code');
  await expect(toolbar.locator('.chief-runtime-meta')).toContainText('Thinking:');
  await expect(toolbar.locator('.chief-runtime-meta')).toContainText('Scoped controls');
  await expect(page.locator('.chief-composer-wrap > .chief-runtime-meta')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  check('The model dropdown and runtime information appear directly in the prompt’s bottom toolbar without a dialog.');

  assert.equal(await modelSelect.evaluate(element => element.tagName), 'SELECT');
  const initialOptions = await modelSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  for (const model of [configuredModel, 'opus', 'sonnet', 'haiku']) assert.ok(initialOptions.includes(model), `Model list must include ${model} before editing the current model.`);
  check('The toolbar dropdown includes the configured default, Opus, Sonnet, and Haiku.');
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Model settings could not be saved.' }) });
    else await route.continue();
  }, { times: 1 });
  await modelSelect.selectOption('sonnet');
  await expect(composer.getByRole('alert')).toContainText('Model settings could not be saved.');
  await expect(modelSelect).toHaveValue(configuredModel);
  assert.equal((await repository.settings(scope)).chiefModel ?? null, null);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let releaseSave: (() => void) | undefined;
  const pendingSave = new Promise<void>(resolveSave => { releaseSave = resolveSave; });
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') await pendingSave;
    await route.continue();
  }, { times: 1 });
  const messageInput = page.getByLabel('Message your chief of staff', { exact: true });
  const unsentMessage = 'Keep this draft while the model selection is saving.';
  try {
    await modelSelect.selectOption('sonnet');
    await expect(modelSelect).toBeDisabled();
    await messageInput.fill(unsentMessage);
    await expect(messageInput).toBeFocused();
    await expect(sendButton).toBeDisabled();
  } finally {
    releaseSave?.();
  }
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(modelSelect).toBeEnabled();
  // Let the save handler's scheduled focus restoration run before checking focus.
  await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  await expect(messageInput).toBeFocused();
  await expect(messageInput).toHaveValue(unsentMessage);
  assert.equal(claude.calls.length, 0);
  assert.equal((await repository.messages(scope)).length, 0);
  check('A pending model save disables sending; completing it preserves the focused prompt draft without sending a message.');
  await expect(composer.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal((await repository.settings(scope)).chiefModel, 'sonnet');
  await page.reload();
  await expect(modelSelect).toHaveValue('sonnet');
  const reopened = new SqliteRepository(databasePath);
  try { assert.equal((await reopened.settings(scope)).chiefModel, 'sonnet'); }
  finally { reopened.close(); }
  check('Choosing a model saves immediately; failure restores the previous selection, and retry saves sonnet across reload and SQLite reopen.');
  await capture(page, '01-chief-model-toolbar-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(modelSelect).toBeVisible();
  await expect(sendButton).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture(page, '02-chief-model-toolbar-mobile');
  await page.getByLabel('Message your chief of staff', { exact: true }).fill('Summarize this fixture without changing any tasks.');
  await expect(sendButton).toBeEnabled();
  await modelSelect.selectOption('');
  await modelInput.fill(customModel);
  await expect(sendButton).toBeDisabled();
  await expect(toolbar.getByRole('button', { name: 'Save model', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Cancel model edit', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture(page, '03-chief-model-inline-edit-mobile');
  await modelInput.press('Escape');
  await expect(modelInput).toHaveCount(0);
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(modelSelect).toBeFocused();
  await expect(sendButton).toBeEnabled();
  assert.equal((await repository.settings(scope)).chiefModel, 'sonnet');
  check('The dropdown and inline custom editor fit a 390px viewport; editing disables sending and Escape cancels with focus restored.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await sendButton.click();
  await expect.poll(() => claude.calls.length).toBe(1);
  assert.equal(claude.calls[0].request.phase, 'chief');
  assert.equal(claude.calls[0].request.model, 'sonnet');
  await expect(modelSelect).toBeDisabled();
  claude.calls[0].finish('The fixture is ready for review.');
  await expect(page.getByText('The fixture is ready for review.', { exact: true })).toBeVisible();
  await expect(modelSelect).toBeEnabled();
  assert.equal((await repository.tasks(scope)).length, 0);
  check('The selected model reaches the Chief provider request, and the model control is disabled until the request completes.');

  await modelSelect.selectOption('');
  await modelInput.fill('discarded-model');
  await toolbar.getByRole('button', { name: 'Cancel model edit', exact: true }).click();
  await expect(modelSelect).toHaveValue('sonnet');
  assert.equal((await repository.settings(scope)).chiefModel, 'sonnet');
  await modelSelect.selectOption('');
  await modelInput.fill(customModel);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await capture(page, '04-chief-model-inline-edit-desktop');
  await modelInput.press('Enter');
  await expect(modelInput).toHaveCount(0);
  await expect(modelSelect).toHaveValue(customModel);
  assert.equal((await repository.settings(scope)).chiefModel, customModel);
  assert.equal(claude.calls.length, 1);
  await page.reload();
  await expect(modelSelect).toHaveValue(customModel);
  const savedOptions = await modelSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  assert.ok(savedOptions.includes(customModel));
  for (const model of [configuredModel, 'opus', 'sonnet', 'haiku']) assert.ok(savedOptions.includes(model));
  check('Custom model IDs save inline with Enter, survive reload beside standard choices, and can be canceled without changing the saved model.');
  await modelSelect.selectOption(configuredModel);
  await expect(modelSelect).toHaveValue(configuredModel);
  assert.equal((await repository.settings(scope)).chiefModel, null);
  await page.reload();
  await expect(modelSelect).toHaveValue(configuredModel);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  check('Selecting the configured default clears the saved override and restores that model after reload.');
  assert.deepEqual(errors, []);
  check('No browser page errors were observed.');
  succeeded = true;
} catch (error) {
  log.push(error instanceof Error ? error.stack ?? error.message : String(error));
  const page = context?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(outputRoot, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(outputRoot, 'failure-dom.html'), await page.content()).catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  for (const call of claude.calls) call.fail(new Error('Chief model fixture cleanup'));
  await service.stop();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  repository.close();
  await writeFile(join(outputRoot, 'report.json'), JSON.stringify({ succeeded, checks, errors, screenshots, outputRoot }, null, 2));
  await writeFile(join(outputRoot, 'run.log'), `${log.join('\n')}\n`);
  if (succeeded) {
    await writeFile(resolve('docs/chief-model-validation.md'), `# Chief model browser validation\n\nPassed ${new Date().toISOString()}.\n\nDedicated headless Chromium with isolated SQLite and real HTTP. Provider responses are controlled; this does not test authenticated Claude execution. No project commands, user browser tabs, or user database were used.\n\n${checks.map(message => `- ${message}`).join('\n')}\n\n## Evidence\n\n- [Run log](${join(outputRoot, 'run.log')})\n- [JSON report](${join(outputRoot, 'report.json')})\n${screenshots.map(path => `- [${path.split('/').at(-1)}](${path})`).join('\n')}\n\nRerun: \`pnpm run build && pnpm exec tsx scripts/chief-model-browser-check.ts\`. Install Chromium once with \`pnpm exec playwright install chromium\`.\n`);
  }
  console.log(JSON.stringify({ succeeded, outputRoot, checks: checks.length, errors }));
}
