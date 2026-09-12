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
  const toolbar = page.locator('.chief-composer .composer-bottom');
  const modelButton = toolbar.getByRole('button', { name: 'Change Chief of staff model', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Chief of staff model', exact: true });
  const modelSelect = dialog.getByRole('combobox', { name: 'Model', exact: true });
  const configuredModel = (await service.snapshot()).runtime.config!.claude.model;
  await expect(modelButton).toContainText(configuredModel);
  await expect(toolbar.locator('.chief-runtime-meta')).toContainText('Claude Code');
  await expect(toolbar.locator('.chief-runtime-meta')).toContainText('Thinking:');
  await expect(toolbar.locator('.chief-runtime-meta')).toContainText('Scoped controls');
  await expect(page.locator('.chief-composer-wrap > .chief-runtime-meta')).toHaveCount(0);
  check('Model controls and runtime information appear in the prompt’s bottom toolbar.');

  await modelButton.click();
  await expect(modelSelect).toHaveValue(configuredModel);
  assert.equal(await modelSelect.evaluate(element => element.tagName), 'SELECT');
  const initialOptions = await modelSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  for (const model of [configuredModel, 'opus', 'sonnet', 'haiku']) assert.ok(initialOptions.includes(model), `Model list must include ${model} before editing the current model.`);
  check('The model dropdown includes the configured default, Opus, Sonnet, and Haiku immediately when opened.');
  await modelSelect.selectOption('sonnet');
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Model settings could not be saved.' }) });
    else await route.continue();
  }, { times: 1 });
  await dialog.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Model settings could not be saved.');
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(page.locator('#chief-current-model')).toHaveText(configuredModel);
  assert.equal((await repository.settings(scope)).chiefModel ?? null, null);
  await dialog.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(modelButton).toContainText('sonnet');
  assert.equal((await repository.settings(scope)).chiefModel, 'sonnet');
  await page.reload();
  await expect(modelButton).toContainText('sonnet');
  const reopened = new SqliteRepository(databasePath);
  try { assert.equal((await reopened.settings(scope)).chiefModel, 'sonnet'); }
  finally { reopened.close(); }
  check('A failed save retains the draft and current model; retry saves sonnet across reload and SQLite reopen.');
  await capture(page, '01-chief-model-toolbar-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(modelButton).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture(page, '02-chief-model-toolbar-mobile');
  await modelButton.click();
  await expect(modelSelect).toHaveValue('sonnet');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture(page, '03-chief-model-dialog-mobile');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(modelButton).toBeFocused();
  check('The toolbar and model dialog fit a 390px mobile viewport; Escape restores focus to the model control.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Message your chief of staff', { exact: true }).fill('Summarize this fixture without changing any tasks.');
  await toolbar.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => claude.calls.length).toBe(1);
  assert.equal(claude.calls[0].request.phase, 'chief');
  assert.equal(claude.calls[0].request.model, 'sonnet');
  await expect(modelButton).toBeDisabled();
  claude.calls[0].finish('The fixture is ready for review.');
  await expect(page.getByText('The fixture is ready for review.', { exact: true })).toBeVisible();
  await expect(modelButton).toBeEnabled();
  assert.equal((await repository.tasks(scope)).length, 0);
  check('The selected model reaches the Chief provider request, and the model control is disabled until the request completes.');

  await modelButton.click();
  await dialog.getByRole('button', { name: 'Enter model ID', exact: true }).click();
  const modelInput = dialog.getByRole('textbox', { name: 'Model', exact: true });
  await expect(modelInput).toHaveValue('sonnet');
  await dialog.getByRole('button', { name: 'Choose from list', exact: true }).click();
  await expect(modelSelect).toHaveValue('sonnet');
  await dialog.getByRole('button', { name: 'Enter model ID', exact: true }).click();
  const customModel = 'claude-fixture[1m]';
  await modelInput.fill(customModel);
  await dialog.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(modelButton).toContainText(customModel);
  assert.equal((await repository.settings(scope)).chiefModel, customModel);
  await page.reload();
  await expect(modelButton).toContainText(customModel);
  await modelButton.click();
  await expect(modelSelect).toHaveValue(customModel);
  const savedOptions = await modelSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  assert.ok(savedOptions.includes(customModel));
  for (const model of [configuredModel, 'opus', 'sonnet', 'haiku']) assert.ok(savedOptions.includes(model));
  check('Custom model entry remains available; a saved model ID survives reload and appears beside the standard choices when reopened.');
  await dialog.getByRole('button', { name: 'Use default', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(modelButton).toContainText(configuredModel);
  assert.equal((await repository.settings(scope)).chiefModel, null);
  await page.reload();
  await expect(modelButton).toContainText(configuredModel);
  check('Use default clears the saved override and restores the configured model after reload.');
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
