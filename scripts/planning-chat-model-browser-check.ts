import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { chromium, expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
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
      request.signal?.addEventListener('abort', () => reject(new Error('Planning chat model fixture stopped')), { once: true });
      this.calls.push({ request, finish: text => resolveRun({ text }), fail: reject });
    });
  }
}

await mkdir(resolve('.muon/validation'), { recursive: true });
const outputRoot = await mkdtemp(resolve('.muon/validation/planning-chat-model-'));
const repositoryPath = join(outputRoot, 'repository');
await mkdir(repositoryPath);
await writeFile(join(repositoryPath, 'README.md'), '# Planning chat model browser fixture\n');
const scope = { workspaceId: 'planning-chat-model-browser', projectId: 'isolated-project', userId: 'test-owner' };
const repository = new SqliteRepository(join(outputRoot, 'muon.sqlite'));
await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Planning chat model fixture', identifier: 'PM', repositoryPath }, { defaultProvider: 'claude', dispatcherEnabled: false, maxConcurrentAgents: 1 });
const claude = new ControlledAdapter('claude');
const codex = new ControlledAdapter('codex');
const artifacts = new LocalArtifactStore(join(outputRoot, 'artifacts'));
const port = Number(process.env.MUON_PLANNING_CHAT_MODEL_BROWSER_PORT ?? 4335);
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
const log: string[] = [`Planning chat model browser fixture: ${outputRoot}`];
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
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shape the work together', exact: true })).toBeVisible();
  const chatUrl = page.url();
  const chatId = decodeURIComponent(new URL(chatUrl).pathname.split('/').at(-1)!);
  const chatEndpoint = `**/api/planning-chats/${chatId}`;
  const composer = page.locator('.planning-chat-composer-wrap');
  const toolbar = composer.locator('.composer-bottom');
  const modelSelect = toolbar.getByRole('combobox', { name: 'Planning chat model', exact: true });
  const modelInput = toolbar.getByRole('textbox', { name: 'Custom planning chat model', exact: true });
  const messageInput = page.getByLabel('Message your planning partner', { exact: true });
  const sendButton = toolbar.getByRole('button', { name: 'Send message', exact: true });
  const configuredModel = (await service.snapshot()).runtime.config!.claude.model;
  const customModel = 'claude-fixture[1m]';
  await expect(modelSelect).toHaveValue(configuredModel);
  assert.equal(await modelSelect.evaluate(element => element.tagName), 'SELECT');
  const initialOptions = await modelSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  for (const model of [configuredModel, 'opus', 'sonnet', 'haiku']) assert.ok(initialOptions.includes(model), `Model list must include ${model}.`);
  assert.equal(service.getPlanningChat(chatId).model, null);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  check('The planning composer has an accessible model dropdown with the configured default, Opus, Sonnet, and Haiku.');

  const firstMessage = 'Help me scope a task without changing any repository files.';
  await messageInput.fill(firstMessage);
  await sendButton.click();
  await expect.poll(() => claude.calls.length).toBe(1);
  assert.equal(claude.calls[0].request.phase, 'chat');
  await expect(modelSelect).toBeDisabled();
  await expect(page.locator('.chief-working')).toBeVisible();
  let releaseStalePoll: (() => void) | undefined;
  let releaseSave: (() => void) | undefined;
  let stalePollCaptured = false;
  let stalePollRequest: Request | undefined;
  let holdNextPoll = true;
  let slowPolling = true;
  let slowPolls = 0;
  let failNextSave = false;
  let holdNextSave = false;
  const saveError = 'The planning model could not be saved.';
  const stalePoll = new Promise<void>(resolvePoll => { releaseStalePoll = resolvePoll; });
  const pendingSave = new Promise<void>(resolveSave => { releaseSave = resolveSave; });
  await page.route(chatEndpoint, async route => {
    if (route.request().method() === 'GET' && holdNextPoll) {
      holdNextPoll = false;
      const response = await route.fetch();
      stalePollRequest = route.request();
      stalePollCaptured = true;
      await stalePoll;
      await route.fulfill({ response });
    } else if (route.request().method() === 'GET' && slowPolling) {
      const response = await route.fetch();
      ++slowPolls;
      // Exceed the UI's polling interval to verify overlapping loads still make progress.
      await delay(1600);
      await route.fulfill({ response });
    } else if (route.request().method() === 'PATCH' && failNextSave) {
      failNextSave = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: saveError }) });
    } else {
      if (route.request().method() === 'PATCH' && holdNextSave) {
        holdNextSave = false;
        await pendingSave;
      }
      await route.continue();
    }
  });
  await expect.poll(() => stalePollCaptured).toBe(true);
  const limitMessage = "You've reached your Fable limit. Switch to another model to continue.";
  claude.calls[0].fail(new Error(limitMessage));
  await expect(page.getByRole('alert').filter({ hasText: limitMessage })).toBeVisible();
  await expect(modelSelect).toBeEnabled();
  slowPolling = false;
  assert.ok(slowPolls > 0);
  check('Polling responses slower than the polling interval still update the completed turn and enable model selection.');
  await expect(page.getByText(firstMessage, { exact: true })).toBeVisible();
  const preservedMessages = service.getPlanningChat(chatId).messages.map(message => ({ ...message }));
  assert.equal(preservedMessages.length, 1);
  await capture(page, '01-planning-chat-limit-desktop');
  check('A simulated Fable limit keeps the planning conversation open, and model changes become available after the failed turn.');

  const draft = 'Continue with the same task scope using the selected model.';
  await messageInput.fill(draft);
  failNextSave = true;
  await modelSelect.selectOption('sonnet');
  await expect(composer.getByRole('alert')).toContainText(saveError);
  await expect(modelSelect).toHaveValue(configuredModel);
  await expect(messageInput).toHaveValue(draft);
  assert.equal(service.getPlanningChat(chatId).model, null);
  assert.deepEqual(service.getPlanningChat(chatId).messages, preservedMessages);
  check('A rejected model save restores the previous selection and preserves both the conversation and unsent draft for retry.');

  holdNextSave = true;
  try {
    await modelSelect.selectOption('sonnet');
    await expect(modelSelect).toBeDisabled();
    await expect(sendButton).toBeDisabled();
    await messageInput.press('Enter');
    await expect(messageInput).toHaveValue(draft);
    assert.equal(claude.calls.length, 1);
    assert.deepEqual(service.getPlanningChat(chatId).messages, preservedMessages);
  } finally {
    releaseSave?.();
  }
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(modelSelect).toBeEnabled();
  await expect(sendButton).toBeEnabled();
  await expect(messageInput).toHaveValue(draft);
  await expect(composer.getByRole('alert')).toHaveCount(0);
  assert.equal(service.getPlanningChat(chatId).model, 'sonnet');
  const staleResponse = page.waitForResponse(response => response.request() === stalePollRequest);
  releaseStalePoll?.();
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(modelSelect).toBeEnabled();
  await expect(messageInput).toHaveValue(draft);
  await expect(page.getByRole('alert').filter({ hasText: limitMessage })).toBeVisible();
  check('An older delayed chat poll cannot overwrite the saved model or restore the obsolete running state.');
  await page.reload();
  await expect(page).toHaveURL(chatUrl);
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(page.getByText(firstMessage, { exact: true })).toBeVisible();
  assert.deepEqual(service.getPlanningChat(chatId).messages, preservedMessages);
  check('A pending model save blocks button and Enter submission; retry saves sonnet across reload of the same planning URL.');

  await messageInput.fill(draft);
  await sendButton.click();
  await expect.poll(() => claude.calls.length).toBe(2);
  const switchedRequest = claude.calls[1].request;
  assert.equal(switchedRequest.provider, 'claude');
  assert.equal(switchedRequest.phase, 'chat');
  assert.equal(switchedRequest.model, 'sonnet');
  assert.equal(switchedRequest.cwd, repositoryPath);
  assert.ok(switchedRequest.prompt.includes(firstMessage));
  assert.ok(switchedRequest.prompt.includes(draft));
  await expect(modelSelect).toBeDisabled();
  const reply = 'Your earlier task scope is preserved. We can continue planning with this model.';
  claude.calls[1].finish(reply);
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await expect(modelSelect).toBeEnabled();
  await expect(page.getByRole('alert').filter({ hasText: limitMessage })).toHaveCount(0);
  assert.equal(service.getPlanningChat(chatId).messages.length, 3);
  assert.equal((await repository.tasks(scope)).length, 0);
  assert.equal(codex.calls.length, 0);
  await capture(page, '02-planning-chat-switched-desktop');
  check('After the limit failure, sonnet reaches the chat phase with the original conversation; model changes stay disabled until the reply completes.');

  const messagesAfterReply = service.getPlanningChat(chatId).messages.map(message => ({ ...message }));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(modelSelect).toBeVisible();
  await expect(sendButton).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture(page, '03-planning-chat-model-mobile');
  const editDraft = 'Keep this draft during custom model editing.';
  await messageInput.fill(editDraft);
  await modelSelect.selectOption('');
  await modelInput.fill('discarded-model');
  await expect(sendButton).toBeDisabled();
  await expect(toolbar.getByRole('button', { name: 'Save model', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Cancel model edit', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture(page, '04-planning-chat-custom-mobile');
  await modelInput.press('Escape');
  await expect(modelInput).toHaveCount(0);
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(modelSelect).toBeFocused();
  await expect(page).toHaveURL(chatUrl);
  await expect(messageInput).toHaveValue(editDraft);
  await expect(sendButton).toBeEnabled();
  assert.equal(service.getPlanningChat(chatId).model, 'sonnet');
  assert.deepEqual(service.getPlanningChat(chatId).messages, messagesAfterReply);
  check('The dropdown and custom editor fit a 390px viewport; Escape cancels editing without discarding the planning thread or draft.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await modelSelect.selectOption('');
  await modelInput.fill('also-discarded-model');
  await toolbar.getByRole('button', { name: 'Cancel model edit', exact: true }).click();
  await expect(modelSelect).toHaveValue('sonnet');
  await expect(messageInput).toHaveValue(editDraft);
  await modelSelect.selectOption('');
  await modelInput.fill(customModel);
  await expect(sendButton).toBeDisabled();
  await messageInput.press('Enter');
  await expect(messageInput).toHaveValue(editDraft);
  assert.equal(claude.calls.length, 2);
  await capture(page, '05-planning-chat-custom-desktop');
  await modelInput.press('Enter');
  await expect(modelInput).toHaveCount(0);
  await expect(modelSelect).toHaveValue(customModel);
  await expect(messageInput).toHaveValue(editDraft);
  assert.equal(service.getPlanningChat(chatId).model, customModel);
  assert.deepEqual(service.getPlanningChat(chatId).messages, messagesAfterReply);
  assert.equal(claude.calls.length, 2);
  await page.reload();
  await expect(page).toHaveURL(chatUrl);
  await expect(modelSelect).toHaveValue(customModel);
  const customOptions = await modelSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  for (const model of [configuredModel, 'opus', 'sonnet', 'haiku', customModel]) assert.ok(customOptions.includes(model));
  check('Custom IDs save with Enter and survive reload beside the standard choices; editing blocks message submission and Cancel preserves the draft.');

  await modelSelect.selectOption(configuredModel);
  await expect(modelSelect).toHaveValue(configuredModel);
  await expect(modelSelect).toBeEnabled();
  assert.equal(service.getPlanningChat(chatId).model, null);
  await page.reload();
  await expect(modelSelect).toHaveValue(configuredModel);
  assert.deepEqual(service.getPlanningChat(chatId).messages, messagesAfterReply);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  check('Selecting the configured default clears the per-chat model override and retains the conversation across reload.');

  await messageInput.fill('Do not carry this draft into the next planning thread.');
  await modelSelect.selectOption('');
  await modelInput.fill('unsaved-previous-chat-model');
  await page.getByRole('heading', { name: 'Shape the work together', exact: true }).click();
  await page.keyboard.press('c');
  await expect(page).not.toHaveURL(chatUrl);
  const nextChatId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)!);
  await expect(modelInput).toHaveCount(0);
  await expect(modelSelect).toHaveValue(configuredModel);
  await expect(modelSelect).toBeEnabled();
  await expect(messageInput).toHaveValue('');
  await expect(sendButton).toBeDisabled();
  await expect(page.getByText(firstMessage, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  assert.equal(service.getPlanningChat(nextChatId).model, null);
  assert.deepEqual(service.getPlanningChat(nextChatId).messages, []);
  assert.throws(() => service.getPlanningChat(chatId), /Planning chat not found or already discarded/);
  assert.equal(claude.calls.length, 2);
  await capture(page, '06-new-planning-chat-reset-desktop');
  check('Opening a new planning thread resets the custom model editor, unsent message draft, model selection, and conversation without reloading the page.');

  const expiredChatUrl = page.url();
  service.discardPlanningChat(nextChatId);
  await page.reload();
  const missingChatMessage = 'This planning chat is no longer available.';
  await expect(page.getByText(missingChatMessage, { exact: true })).toBeVisible();
  await expect(page.getByText('It may have been discarded or lost when the server restarted.', { exact: true })).toBeVisible();
  await expect(messageInput).toHaveCount(0);
  const startNewChat = page.getByRole('button', { name: 'Start new chat', exact: true });
  const createTask = page.locator('.sidebar-create').getByRole('button');
  await expect(startNewChat).toBeEnabled();
  await capture(page, '07-missing-planning-chat-desktop');

  let createRequests = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/planning-chats') ++createRequests;
  });
  let releaseCreation: (() => void) | undefined;
  const pendingCreation = new Promise<void>(resolveCreation => { releaseCreation = resolveCreation; });
  await page.route('**/api/planning-chats', async route => {
    if (route.request().method() === 'POST') await pendingCreation;
    await route.continue();
  });
  try {
    await startNewChat.click();
    await expect.poll(() => createRequests).toBe(1);
    await expect(page.getByRole('button', { name: 'Opening chat…', exact: true })).toBeDisabled();
    await expect(createTask).toBeDisabled();
  } finally {
    releaseCreation?.();
  }
  await expect(page).not.toHaveURL(expiredChatUrl);
  await expect(messageInput).toHaveValue('');
  await expect(modelSelect).toBeEnabled();
  await expect(page.locator('.global-error')).toHaveCount(0);
  const recoveredChatId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)!);
  assert.deepEqual(service.getPlanningChat(recoveredChatId).messages, []);
  assert.equal((await service.snapshot()).project.repositoryPath, repositoryPath);
  await messageInput.fill('Confirm this recovered chat uses the selected workspace repository.');
  await sendButton.click();
  await expect.poll(() => claude.calls.length).toBe(3);
  assert.equal(claude.calls[2].request.cwd, repositoryPath);
  const recoveredReply = 'This recovered chat is using the selected workspace repository.';
  claude.calls[2].finish(recoveredReply);
  await expect(page.getByText(recoveredReply, { exact: true })).toBeVisible();
  await expect(modelSelect).toBeEnabled();
  await capture(page, '08-recovered-planning-chat-desktop');
  check('A discarded chat explains its expiry and offers Start new chat; recovery prevents duplicate creation and sends messages from the selected repository.');

  const nonexistentChatUrl = `${url}/planning-chats/nonexistent-browser-fixture`;
  await page.goto(nonexistentChatUrl);
  await expect(page.getByText(missingChatMessage, { exact: true })).toBeVisible();
  await createTask.click();
  await expect(page).not.toHaveURL(nonexistentChatUrl);
  await expect(messageInput).toHaveValue('');
  await expect(modelSelect).toBeEnabled();
  await expect(page.locator('.global-error')).toHaveCount(0);
  check('Sidebar Create task opens a fresh planning chat from an unavailable chat URL without leaving a stale global error.');

  const retryChatUrl = page.url();
  const retryChatId = decodeURIComponent(new URL(retryChatUrl).pathname.split('/').at(-1)!);
  const deleteError = 'The planning chat could not be discarded. Please retry.';
  let failDiscard = true;
  let discardHeld = false;
  let releaseDiscard: (() => void) | undefined;
  const pendingDiscard = new Promise<void>(resolveDiscard => { releaseDiscard = resolveDiscard; });
  await page.route(`**/api/planning-chats/${retryChatId}`, async route => {
    if (route.request().method() === 'DELETE') {
      if (failDiscard) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: deleteError }) });
        return;
      }
      discardHeld = true;
      await pendingDiscard;
    }
    await route.continue();
  });
  const requestsBeforeFailure = createRequests;
  await createTask.click();
  await expect(page.locator('.global-error')).toContainText(deleteError);
  await expect(createTask).toBeEnabled();
  await expect(page).toHaveURL(retryChatUrl);
  assert.equal(createRequests, requestsBeforeFailure);
  assert.equal(service.getPlanningChat(retryChatId).id, retryChatId);
  failDiscard = false;
  try {
    await createTask.click();
    await expect.poll(() => discardHeld).toBe(true);
    await expect(createTask).toBeDisabled();
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally {
    releaseDiscard?.();
  }
  await expect(page).not.toHaveURL(retryChatUrl);
  await expect(messageInput).toHaveValue('');
  await expect(modelSelect).toBeEnabled();
  await expect(page.locator('.global-error')).toHaveCount(0);
  assert.equal(createRequests, requestsBeforeFailure + 1);
  assert.throws(() => service.getPlanningChat(retryChatId), /Planning chat not found or already discarded/);
  await capture(page, '09-planning-chat-retry-desktop');
  check('A non-404 discard failure preserves the current chat and blocks replacement; retry clears the error immediately and creates exactly one fresh chat.');
  assert.deepEqual(errors, []);
  check('No browser page errors were observed.');
  succeeded = true;
} catch (error) {
  log.push(error instanceof Error ? error.stack ?? error.message : String(error));
  const page = context?.pages()[0];
  if (page) {
    await page.screenshot({ path: join(outputRoot, 'failure.png'), fullPage: true }).catch(cause => log.push(`Failure screenshot unavailable: ${String(cause)}`));
    await writeFile(join(outputRoot, 'failure-dom.html'), await page.content()).catch(cause => log.push(`Failure DOM unavailable: ${String(cause)}`));
  }
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  for (const call of claude.calls) call.fail(new Error('Planning chat model fixture cleanup'));
  await service.stop();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  repository.close();
  await writeFile(join(outputRoot, 'report.json'), JSON.stringify({ succeeded, checks, errors, screenshots, outputRoot }, null, 2));
  await writeFile(join(outputRoot, 'run.log'), `${log.join('\n')}\n`);
  console.log(JSON.stringify({ succeeded, outputRoot, checks: checks.length, errors }));
}
