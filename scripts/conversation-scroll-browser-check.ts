import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { LocalWorktreeProvider, type AgentAdapter, type AgentRequest, type AgentResult } from '../src/runtime';
import { createHttpApp } from '../src/server/http-app';
import { singleProjectResolver } from '../src/server/project-registry';
import { LocalArtifactStore } from '../src/server/local-artifacts';
import { LocalChiefCommands } from '../src/server/local-chief-commands';
import { SqliteRepository } from '../src/server/sqlite-repository';
import { TaskService } from '../src/server/task-service';
import type { ChiefMessage, Plan, Task } from '../src/shared/types';

// Production UI, real HTTP and SQLite, and dedicated Chromium contexts. Providers
// are controlled, dispatch stays paused, and no real model or owner data is used.
class ControlledAdapter implements AgentAdapter {
  calls: { request: AgentRequest; finish: (text: string) => void; fail: (error: Error) => void }[] = [];
  constructor(readonly provider: 'claude' | 'codex') {}
  async available() { return true; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolveRun, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Scroll fixture stopped')), { once: true });
      this.calls.push({ request, finish: text => resolveRun({ text }), fail: reject });
    });
  }
}

type Surface = 'chief' | 'planning' | 'comments' | 'plan';
interface Conversation {
  surface: Surface;
  path: string;
  endpoint: string;
  scroller: string;
  composer: string;
  input: string;
  send: string;
  imagePrefix: string;
  taskId?: string;
  taskTitle?: string;
  chatId?: string;
}
interface Metrics {
  top: number;
  height: number;
  viewport: number;
  distance: number;
  firstId: string | null;
  offset: number | null;
}

await mkdir(resolve('.muon/validation'), { recursive: true });
const outputRoot = await mkdtemp(resolve('.muon/validation/conversation-scroll-'));
const repositoryPath = join(outputRoot, 'repository');
await mkdir(repositoryPath);
await writeFile(join(repositoryPath, 'README.md'), '# Isolated conversation scroll fixture\n');
const scope = { workspaceId: 'conversation-scroll-browser', projectId: 'isolated-project', userId: 'test-owner' };
const repository = new SqliteRepository(join(outputRoot, 'muon.sqlite'));
await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Conversation scroll fixture', identifier: 'SC', repositoryPath }, { defaultProvider: 'claude', dispatcherEnabled: false, maxConcurrentAgents: 1 });
const claude = new ControlledAdapter('claude');
const codex = new ControlledAdapter('codex');
const artifacts = new LocalArtifactStore(join(outputRoot, 'artifacts'));
const port = Number(process.env.MUON_SCROLL_BROWSER_PORT ?? 4341);
const url = `http://127.0.0.1:${port}`;
const chiefCommands = new LocalChiefCommands({ apiUrl: url, scope });
const service = new TaskService({ scope, repository, artifacts, chiefCommands, workspaces: new LocalWorktreeProvider(join(outputRoot, 'worktrees')), adapters: { claude, codex } });
await service.initialize();
service.start();
const app = createHttpApp(singleProjectResolver(service), artifacts, { port, staticRoot: resolve('dist'), access: chiefCommands });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
await once(server, 'listening');
const browser = await chromium.launch({ headless: true });
const checks: string[] = [];
const errors: string[] = [];
const failures: { scenario: string; error: string }[] = [];
const measurements: Record<string, unknown> = {};
const screenshots: string[] = [];
const timestamp = new Date().toISOString();
let serial = 0;
let seededChief = false;
let succeeded = false;

function check(name: string) { checks.push(name); console.log(`PASS ${name}`); }
function message(prefix: string, index: number): ChiefMessage {
  const role = index % 2 ? 'assistant' : 'user';
  let content = `${prefix} message ${index}.\n\n${'A controlled conversation message keeps a stable place in the history. '.repeat(7)}`;
  if (index === 4 || index === 20) content += `\n\n![Delayed fixture image](/api/artifacts/scroll-fixture-${prefix}-${index})`;
  if (index === 5 && (prefix.includes('comments') || prefix.includes('plan-'))) content += `\n\n${'A long reply can expand without moving the reader away from another message. '.repeat(55)}`;
  return { id: `${prefix}-${index}`, role, content, createdAt: timestamp };
}
function plan(version: number): Plan {
  return { id: `plan-${++serial}`, version, format: 'markdown', content: '# Browser fixture RFC\n\nA controlled conversation scroll acceptance fixture.\n\n## Acceptance\nPreserve the owner approval gate.', status: 'pending', createdAt: timestamp };
}
async function fixture(surface: Surface, profile: string): Promise<Conversation> {
  const imagePrefix = surface === 'chief' ? 'chief' : `${surface}-${profile}`;
  const messages = Array.from({ length: 28 }, (_, index) => message(imagePrefix, index));
  if (surface === 'chief') {
    if (!seededChief) {
      for (const item of messages) await repository.appendMessage(scope, item);
      seededChief = true;
    }
    return { surface, imagePrefix, path: '/chief', endpoint: '/chief/messages', scroller: '.chief-conversation', composer: '.chief-composer', input: '#chief-message', send: 'Send message' };
  }
  if (surface === 'planning') {
    const chat = service.createPlanningChat();
    chat.messages = messages;
    return { surface, imagePrefix, chatId: chat.id, path: `/planning-chats/${chat.id}`, endpoint: `/planning-chats/${chat.id}/messages`, scroller: '.planning-chat-conversation', composer: '.chief-composer', input: '#planning-chat-message', send: 'Send message' };
  }
  const created = await service.createTask({ title: `${profile} ${surface} scroll fixture`, status: 'backlog' });
  const initialPlan = plan(1);
  await repository.saveTask(scope, { ...created, status: 'in_review', phase: 'plan_review', plans: [initialPlan],
    comments: surface === 'comments' ? messages.map((item, index) => ({ ...item, userId: scope.userId, ...(item.role === 'assistant' ? { replyToIds: [messages[index - 1].id] } : {}) })) : [],
    planDiscussion: surface === 'plan' ? messages.map(item => ({ ...item, userId: scope.userId, planId: initialPlan.id })) : [],
  }, created.version);
  return { surface, imagePrefix, taskId: created.id, taskTitle: created.title, path: `/tasks/${created.id}`, endpoint: `/tasks/${created.id}/${surface === 'comments' ? 'comments' : 'plan-discussion'}`,
    scroller: surface === 'comments' ? '.task-comments-messages' : '.plan-discussion-messages', composer: surface === 'comments' ? '.task-comments-composer' : '.plan-comment-form',
    input: surface === 'comments' ? '.task-comments-composer textarea' : '.plan-comment-form textarea', send: surface === 'comments' ? 'Send task comment' : 'Send comment' };
}
async function renderFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
}
async function metric(page: Page, conversation: Conversation): Promise<Metrics> {
  return page.locator(conversation.scroller).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const first = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(article => article.getBoundingClientRect().bottom > bounds.top + 1);
    return { top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight, distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      firstId: first?.dataset.messageId ?? null, offset: first ? first.getBoundingClientRect().top - bounds.top : null };
  });
}
async function position(page: Page, conversation: Conversation, target: 'bottom' | 'history') {
  const scroller = page.locator(conversation.scroller);
  await scroller.hover();
  const before = await metric(page, conversation);
  const top = target === 'bottom' ? before.height - before.viewport : (before.height - before.viewport) * 0.45;
  await page.mouse.wheel(0, top - before.top);
  if (target === 'bottom') await atBottom(page, conversation);
  else {
    await expect.poll(async () => (await metric(page, conversation)).distance).toBeGreaterThan(80);
    await expect(viewport(page, conversation).getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  }
  await renderFrames(page);
}
async function atBottom(page: Page, conversation: Conversation, label = `${conversation.surface}-bottom`) {
  try {
    await expect.poll(async () => Math.abs((await metric(page, conversation)).distance)).toBeLessThanOrEqual(2);
  } catch (error) {
    const current = await metric(page, conversation);
    measurements[label] = current;
    throw new Error(`${label}: expected bottom alignment, received ${JSON.stringify(current)}`, { cause: error });
  }
}
async function sameAnchor(page: Page, conversation: Conversation, before: Metrics, label: string) {
  await renderFrames(page);
  const after = await metric(page, conversation);
  measurements[label] = { before, after };
  assert.ok(before.firstId, `${label}: expected an identifiable visible message`);
  assert.equal(after.firstId, before.firstId, `${label}: first visible message changed`);
  assert.ok(Math.abs((after.offset ?? 0) - (before.offset ?? 0)) <= 2, `${label}: message offset moved by ${Math.abs((after.offset ?? 0) - (before.offset ?? 0))}px`);
}
function viewport(page: Page, conversation: Conversation): Locator {
  return page.locator(conversation.scroller).locator('..');
}
async function capture(page: Page, name: string) {
  const path = join(outputRoot, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(path);
}
async function showConversation(page: Page, conversation: Conversation) {
  if (conversation.taskId) {
    await page.getByRole('tab', { name: conversation.surface === 'comments' ? /^Comments/ : /^Plan/ }).click();
    if (conversation.surface === 'plan') {
      const discussion = page.getByRole('button', { name: 'Discussion', exact: true });
      if (await discussion.isVisible()) await discussion.click();
    }
  }
  await expect(page.locator(conversation.scroller)).toBeVisible();
  await expect(page.locator(conversation.scroller).locator('[data-message-id]').first()).toBeAttached();
  await renderFrames(page);
}
async function appendReply(conversation: Conversation, content: string): Promise<string> {
  const reply: ChiefMessage = { id: `reply-${++serial}`, role: 'assistant', content, createdAt: new Date().toISOString() };
  if (conversation.surface === 'chief') await repository.appendMessage(scope, reply);
  else if (conversation.chatId) {
    const chat = service.getPlanningChat(conversation.chatId);
    chat.messages = [...chat.messages, reply];
  } else {
    const task = await service.getTask(conversation.taskId!);
    const next: Task = { ...task, followUp: undefined, status: 'in_review', phase: 'plan_review' };
    if (conversation.surface === 'comments') next.comments = [...(task.comments ?? []), { ...reply, replyToIds: task.comments?.filter(item => item.role === 'user').map(item => item.id) }];
    else {
      const nextPlan = task.phase === 'planning' ? plan(task.plans.length + 1) : task.plans.at(-1)!;
      if (nextPlan !== task.plans.at(-1)) next.plans = [...task.plans, nextPlan];
      next.planDiscussion = [...(task.planDiscussion ?? []), { ...reply, planId: nextPlan.id }];
    }
    await repository.saveTask(scope, next, task.version);
  }
  return reply.id;
}
async function send(page: Page, conversation: Conversation, text: string) {
  const callIndex = claude.calls.length;
  await page.locator(conversation.input).fill(text);
  await page.getByRole('button', { name: conversation.send, exact: true }).click();
  if (conversation.surface === 'chief' || conversation.surface === 'planning') {
    await expect.poll(() => claude.calls.length).toBeGreaterThan(callIndex);
    assert.equal(claude.calls[callIndex].request.phase, conversation.surface === 'chief' ? 'chief' : 'chat');
    return async (reply: string) => {
      claude.calls[callIndex].finish(reply);
      await expect(page.locator(conversation.scroller).getByText(reply, { exact: true })).toBeAttached();
    };
  }
  return async (reply: string) => {
    await appendReply(conversation, reply);
    await expect(page.locator(conversation.scroller).getByText(reply, { exact: true })).toBeAttached();
  };
}
async function navigation(page: Page, destination: 'All tasks' | 'Chief of staff') {
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  await nav.getByRole('button', { name: new RegExp(`^${destination}`) }).click();
}

async function runSurface(profile: string, dimensions: { width: number; height: number }, surface: Surface) {
  const scenario = `${profile}-${surface}`;
  const conversation = await fixture(surface, profile);
  const context: BrowserContext = await browser.newContext({ viewport: dimensions, reducedMotion: 'reduce' });
  context.setDefaultTimeout(12_000);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${scenario}: ${error.message}`));
  const releases: (() => void)[] = [];
  const images = new Map<number, { release: () => void; loaded: boolean }>();
  for (const index of [4, 20]) {
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const state = { release, loaded: false };
    images.set(index, state); releases.push(release);
    await page.route(`**/api/artifacts/scroll-fixture-${conversation.imagePrefix}-${index}`, async route => {
      await gate;
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#b9d9cb"/><text x="30" y="125" font-size="24">Delayed fixture image</text></svg>' });
      state.loaded = true;
    });
  }
  try {
    await page.goto(`${url}${conversation.path}`, { waitUntil: 'domcontentloaded' });
    await showConversation(page, conversation);
    await atBottom(page, conversation);
    await expect(viewport(page, conversation)).toHaveClass(/conversation-viewport/);
    const initial = await metric(page, conversation);
    assert.ok(initial.height > initial.viewport * 2, `${scenario}: history must overflow`);
    const composer = await page.locator(conversation.composer).boundingBox();
    assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= dimensions.height + 2, `${scenario}: composer must fit the viewport`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    measurements[`${scenario}-layout`] = { initial, composer, dimensions };
    check(`${scenario}: long conversation opens at latest with visible composer and no horizontal overflow`);

    await position(page, conversation, 'history');
    const historyImageBefore = await metric(page, conversation);
    await page.locator(conversation.scroller).locator('img').evaluateAll(elements => { for (const element of elements) (element as HTMLImageElement).loading = 'eager'; });
    images.get(4)!.release();
    await expect.poll(() => images.get(4)!.loaded).toBe(true);
    await expect(page.locator(conversation.scroller).locator(`img[src$="-${conversation.imagePrefix}-4"]`)).toHaveJSProperty('complete', true);
    await sameAnchor(page, conversation, historyImageBefore, `${scenario}-delayed-image-history`);
    await position(page, conversation, 'bottom');
    images.get(20)!.release();
    await expect.poll(() => images.get(20)!.loaded).toBe(true);
    await atBottom(page, conversation);
    check(`${scenario}: delayed images preserve history anchors and keep following readers at latest`);

    for (const from of ['bottom', 'history'] as const) {
      await position(page, conversation, from);
      const finish = await send(page, conversation, `${scenario} send from ${from}`);
      await expect(page.locator(conversation.input)).toHaveValue('');
      await atBottom(page, conversation);
      await finish(`${scenario} reply while following ${from}`);
      await atBottom(page, conversation);
      await expect(viewport(page, conversation).getByRole('button', { name: /new messages?/ })).toHaveCount(0);
      check(`${scenario}: sending from ${from} reveals the owner message and follows its reply`);
    }

    const finishDetached = await send(page, conversation, `${scenario} wait while I read history`);
    await expect(page.locator(conversation.input)).toHaveValue('');
    await position(page, conversation, 'history');
    const detached = await metric(page, conversation);
    await page.locator(conversation.scroller).focus();
    const incoming = `${scenario} reply arrives while history is being read`;
    await finishDetached(incoming);
    await sameAnchor(page, conversation, detached, `${scenario}-incoming-history`);
    await expect(page.locator(conversation.scroller)).toBeFocused();
    const unreadButton = viewport(page, conversation).getByRole('button', { name: /^1 new message$/ });
    await expect(unreadButton).toBeVisible();
    await expect(viewport(page, conversation).getByText('New messages', { exact: true })).toHaveCount(1);
    await capture(page, `${scenario}-unread`);
    await unreadButton.click();
    await expect(page.locator(conversation.scroller).getByText(incoming, { exact: true })).toBeInViewport();
    check(`${scenario}: an incoming reply preserves the reading anchor and focus and exposes first-unread navigation`);
    const jump = viewport(page, conversation).getByRole('button', { name: 'Jump to latest', exact: true });
    if (await jump.isVisible()) await jump.click();
    await atBottom(page, conversation);
    await expect(viewport(page, conversation).getByRole('button', { name: /new messages?/ })).toHaveCount(0);

    await position(page, conversation, 'history');
    await expect(jump).toBeVisible();
    await jump.focus();
    await page.keyboard.press('Enter');
    await renderFrames(page);
    await atBottom(page, conversation);
    const focusStayedInside = await page.locator(conversation.scroller).evaluate(element => element === document.activeElement || element.contains(document.activeElement));
    assert.equal(focusStayedInside, true, `${scenario}: disappearing catch-up control should return keyboard focus to the conversation`);
    check(`${scenario}: keyboard Jump to latest lands immediately under reduced motion and retains useful focus`);

    for (const override of [false, true]) {
      await position(page, conversation, 'history');
      let releaseAck!: () => void;
      let accepted = false;
      const gate = new Promise<void>(resolveGate => { releaseAck = resolveGate; });
      releases.push(releaseAck);
      await page.route(`**${conversation.endpoint}`, async route => {
        const response = await route.fetch();
        assert.ok(response.ok(), `${scenario}: delayed POST was rejected`);
        accepted = true;
        await gate;
        await route.fulfill({ response });
      }, { times: 1 });
      const content = `${scenario} delayed acknowledgement ${override ? 'with later scrolling' : 'without later scrolling'}`;
      const finish = await send(page, conversation, content);
      await expect.poll(() => accepted).toBe(true);
      if (surface !== 'planning') await expect(page.locator(conversation.scroller).getByText(content, { exact: true })).toBeAttached();
      else await delay(100);
      if (override) await position(page, conversation, 'history');
      const beforeAck = await metric(page, conversation);
      releaseAck();
      await expect(page.locator(conversation.input)).toHaveValue('');
      if (override) await sameAnchor(page, conversation, beforeAck, `${scenario}-slow-ack-user-scroll`);
      else await atBottom(page, conversation);
      await finish(`${scenario} delayed acknowledgement reply ${override}`);
      if (override) await sameAnchor(page, conversation, beforeAck, `${scenario}-slow-ack-reply`);
      else await atBottom(page, conversation);
      await position(page, conversation, 'bottom');
      check(`${scenario}: delayed POST ${override ? 'honors a later deliberate scroll' : 'follows latest even when polling renders the message before acknowledgement'}`);
    }

    await position(page, conversation, 'history');
    const failedAnchor = await metric(page, conversation);
    const failedDraft = `${scenario} preserve this draft after a rejected send`;
    const failureText = `${scenario} simulated send failure`;
    const callsBeforeFailure = claude.calls.length;
    await page.route(`**${conversation.endpoint}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: failureText }) }), { times: 1 });
    await page.locator(conversation.input).fill(failedDraft);
    await page.getByRole('button', { name: conversation.send, exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: failureText })).toBeVisible();
    await expect(page.locator(conversation.input)).toHaveValue(failedDraft);
    assert.equal(claude.calls.length, callsBeforeFailure);
    await sameAnchor(page, conversation, failedAnchor, `${scenario}-failed-send`);
    const finishRetry = await send(page, conversation, failedDraft);
    await expect(page.locator(conversation.input)).toHaveValue('');
    await atBottom(page, conversation);
    await finishRetry(`${scenario} successful retry reply`);
    await atBottom(page, conversation);
    check(`${scenario}: failed POST retains the draft and reading anchor; a successful retry follows latest`);

    const finishBatch = await send(page, conversation, `${scenario} simulate a brief reconnect`);
    await expect(page.locator(conversation.input)).toHaveValue('');
    await position(page, conversation, 'history');
    const batchAnchor = await metric(page, conversation);
    const pollEndpoint = conversation.chatId ? `/planning-chats/${conversation.chatId}` : '/state';
    let disconnected = true;
    let missedPoll = false;
    await page.route(`**${pollEndpoint}`, async route => {
      if (disconnected && route.request().method() === 'GET') {
        missedPoll = true;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated fixture reconnect' }) });
      } else await route.continue();
    });
    await expect.poll(() => missedPoll).toBe(true);
    for (let index = 0; index < 3; ++index) await appendReply(conversation, `${scenario} batched reply ${index}`);
    disconnected = false;
    await finishBatch(`${scenario} final reply after reconnect`);
    await expect(viewport(page, conversation).getByRole('button', { name: '4 new messages', exact: true })).toBeVisible();
    await sameAnchor(page, conversation, batchAnchor, `${scenario}-reconnect-batch`);
    await position(page, conversation, 'bottom');
    check(`${scenario}: reconnect batching preserves history and counts all four unseen replies`);

    const finishHidden = await send(page, conversation, `${scenario} simulate a hidden document`);
    await expect(page.locator(conversation.input)).toHaveValue('');
    await atBottom(page, conversation);
    // Headless Chromium does not consistently background tabs. Model the exact
    // browser visibility signals explicitly, and label the evidence simulated.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    let firstHidden = '';
    for (let index = 0; index < 5; ++index) {
      const id = await appendReply(conversation, `${scenario} document-hidden reply ${index}.\n\n${'This controlled reply arrived while the document visibility signal was hidden. '.repeat(15)}`);
      if (index === 0) firstHidden = id;
    }
    await finishHidden(`${scenario} last document-hidden reply`);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden');
      Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator(conversation.scroller).locator(`[data-message-id="${firstHidden}"]`)).toBeInViewport();
    await renderFrames(page);
    const visibleAgain = await metric(page, conversation);
    assert.ok(visibleAgain.distance > 80, `${scenario}: document return must not skip the hidden backlog`);
    measurements[`${scenario}-simulated-document-visibility`] = { firstHidden, visibleAgain };
    await position(page, conversation, 'bottom');
    check(`${scenario}: simulated document-hidden replies reopen at first unread instead of skipping to latest`);

    const inputHeight = await page.locator(conversation.input).evaluate(element => (element as HTMLElement).style.height);
    await position(page, conversation, 'history');
    const composerAnchor = await metric(page, conversation);
    const originalComposerHeight = (await page.locator(conversation.composer).boundingBox())!.height;
    await page.locator(conversation.input).evaluate(element => { if (element instanceof HTMLElement) element.style.height = '140px'; });
    await expect.poll(async () => (await page.locator(conversation.composer).boundingBox())!.height).toBeGreaterThan(originalComposerHeight);
    await sameAnchor(page, conversation, composerAnchor, `${scenario}-composer-grow-history`);
    await position(page, conversation, 'bottom');
    await page.locator(conversation.input).evaluate((element, height) => { if (element instanceof HTMLElement) element.style.height = height; }, inputHeight);
    await expect.poll(async () => (await page.locator(conversation.composer).boundingBox())!.height).toBe(originalComposerHeight);
    await atBottom(page, conversation, `${scenario}-composer-after-shrink`);
    await page.locator(conversation.input).evaluate(element => { if (element instanceof HTMLElement) element.style.height = '140px'; });
    await expect.poll(async () => (await page.locator(conversation.composer).boundingBox())!.height).toBeGreaterThan(originalComposerHeight);
    await atBottom(page, conversation, `${scenario}-composer-after-grow`);
    await page.locator(conversation.input).evaluate((element, height) => { if (element instanceof HTMLElement) element.style.height = height; }, inputHeight);
    await expect.poll(async () => (await page.locator(conversation.composer).boundingBox())!.height).toBe(originalComposerHeight);
    await atBottom(page, conversation, `${scenario}-composer-after-restore`);
    check(`${scenario}: controlled composer height growth preserves history and keeps following readers at latest`);

    await position(page, conversation, 'history');
    const resizeAnchor = await metric(page, conversation);
    await page.setViewportSize({ ...dimensions, height: dimensions.height - 130 });
    await expect.poll(async () => (await metric(page, conversation)).viewport).toBeLessThan(resizeAnchor.viewport);
    await sameAnchor(page, conversation, resizeAnchor, `${scenario}-resize-history`);
    await position(page, conversation, 'bottom');
    await page.setViewportSize(dimensions);
    await expect.poll(async () => (await metric(page, conversation)).viewport).toBe(resizeAnchor.viewport);
    await atBottom(page, conversation);
    check(`${scenario}: viewport height changes preserve history or continue following latest`);

    if (profile === 'mobile') {
      const visibleHeight = 400;
      const visibleTop = 24;
      const layoutHeight = await page.evaluate(() => innerHeight);
      await page.locator(conversation.input).focus();
      await page.evaluate(({ height, top }) => {
        const visual = window.visualViewport;
        if (!visual) throw new Error('Visual viewport is unavailable');
        Object.defineProperties(visual, { height: { configurable: true, value: height }, offsetTop: { configurable: true, value: top } });
        visual.dispatchEvent(new Event('resize'));
        visual.dispatchEvent(new Event('scroll'));
      }, { height: visibleHeight, top: visibleTop });
      await expect(page.locator('.app-shell')).toHaveClass(/viewport-compact/);
      await expect.poll(async () => (await page.locator('.app-shell').boundingBox())!.height).toBe(visibleHeight);
      assert.equal(await page.evaluate(() => innerHeight), layoutHeight, 'Synthetic keyboard must leave the layout viewport unchanged');
      await renderFrames(page);
      const keyboardMetrics = await metric(page, conversation);
      const keyboardComposer = await page.locator(conversation.composer).boundingBox();
      const keyboardSend = await page.getByRole('button', { name: conversation.send, exact: true }).boundingBox();
      measurements[`${scenario}-simulated-keyboard`] = { layoutHeight, visibleHeight, visibleTop, keyboardMetrics, keyboardComposer, keyboardSend };
      assert.ok(keyboardMetrics.viewport > 0, `${scenario}: keyboard leaves a positive conversation height`);
      for (const [label, bounds] of [['composer', keyboardComposer], ['send', keyboardSend]] as const) {
        assert.ok(bounds && bounds.y >= visibleTop - 2 && bounds.y + bounds.height <= visibleTop + visibleHeight + 2, `${scenario}: ${label} must fit the simulated visual viewport`);
      }
      await atBottom(page, conversation);
      await capture(page, `${scenario}-simulated-keyboard`);
      await page.evaluate(() => {
        const visual = window.visualViewport!;
        Reflect.deleteProperty(visual, 'height');
        Reflect.deleteProperty(visual, 'offsetTop');
        visual.dispatchEvent(new Event('resize'));
        visual.dispatchEvent(new Event('scroll'));
      });
      await expect(page.locator('.app-shell')).not.toHaveClass(/viewport-compact/);
      await expect.poll(async () => (await metric(page, conversation)).viewport).toBe(resizeAnchor.viewport);
      await atBottom(page, conversation);
      check(`${scenario}: simulated 400px visual viewport with 24px offset retains conversation, composer, and send control; physical keyboard not exercised`);
    }

    if (surface === 'comments' || surface === 'plan') {
      const details = page.locator(conversation.scroller).locator('details').first();
      await expect(details).toBeAttached();
      const row = details.locator('..');
      const rowBounds = await row.boundingBox();
      const scrollBounds = await page.locator(conversation.scroller).boundingBox();
      assert.ok(rowBounds && scrollBounds);
      await page.locator(conversation.scroller).hover();
      await page.mouse.wheel(0, rowBounds.y - scrollBounds.y - 8);
      await expect.poll(async () => Math.abs((await row.boundingBox())!.y - (await page.locator(conversation.scroller).boundingBox())!.y - 8)).toBeLessThanOrEqual(2);
      const detailAnchor = await metric(page, conversation);
      await details.locator('summary').click();
      await expect(details).toHaveAttribute('open', '');
      await sameAnchor(page, conversation, detailAnchor, `${scenario}-details-history`);
      await details.locator('summary').click();
      await sameAnchor(page, conversation, detailAnchor, `${scenario}-details-collapse`);
      check(`${scenario}: expanding and collapsing a long reply preserves the selected message anchor`);

      await position(page, conversation, 'history');
      const tabAnchor = await metric(page, conversation);
      await page.getByRole('tab', { name: 'Overview', exact: true }).click();
      await showConversation(page, conversation);
      await sameAnchor(page, conversation, tabAnchor, `${scenario}-tab-return`);
      await page.getByRole('button', { name: 'Close task', exact: true }).click();
      await page.locator('.task-row').filter({ hasText: conversation.taskTitle }).click();
      await showConversation(page, conversation);
      await sameAnchor(page, conversation, tabAnchor, `${scenario}-task-reopen`);
      check(`${scenario}: tab changes and closing/reopening the task restore the reading anchor`);
    }

    if (surface === 'chief' || surface === 'comments' || surface === 'plan') {
      await position(page, conversation, 'history');
      const hiddenAnchor = await metric(page, conversation);
      const leave = async () => {
        if (surface === 'chief') await navigation(page, 'All tasks');
        else await page.getByRole('tab', { name: 'Overview', exact: true }).click();
      };
      const restore = async () => {
        if (surface === 'chief') await navigation(page, 'Chief of staff');
        else await showConversation(page, conversation);
        await renderFrames(page);
      };
      await leave();
      await restore();
      await sameAnchor(page, conversation, hiddenAnchor, `${scenario}-route-or-tab-restore`);
      await position(page, conversation, 'bottom');
      await leave();
      let firstUnread = '';
      for (let index = 0; index < 7; ++index) {
        const id = await appendReply(conversation, `${scenario} hidden reply ${index}.\n\n${'A reply received while this conversation was hidden remains unread until the owner returns. '.repeat(13)}`);
        if (index === 0) firstUnread = id;
      }
      await delay(2200);
      await restore();
      const firstUnreadArticle = page.locator(conversation.scroller).locator(`[data-message-id="${firstUnread}"]`);
      await expect(firstUnreadArticle).toBeInViewport();
      const restored = await metric(page, conversation);
      measurements[`${scenario}-hidden-arrivals`] = { firstUnread, restored };
      assert.ok(restored.distance > 80, `${scenario}: returning to hidden replies should target first unread instead of skipping to latest`);
      await expect(viewport(page, conversation).getByText('New messages', { exact: true })).toHaveCount(1);
      await expect(viewport(page, conversation).getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
      await capture(page, `${scenario}-hidden-replies`);
      check(`${scenario}: a following reader returns to the first hidden unread reply without skipping the backlog`);
    }
    await capture(page, `${scenario}-complete`);
  } catch (error) {
    failures.push({ scenario, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    console.error(`FAIL ${scenario}: ${error instanceof Error ? error.message : String(error)}`);
    await capture(page, `${scenario}-failure`).catch(cause => errors.push(`Failure screenshot: ${String(cause)}`));
    await writeFile(join(outputRoot, `${scenario}-failure.html`), await page.content());
  } finally {
    for (const release of releases) release();
    for (const call of claude.calls) call.fail(new Error('Scroll scenario cleanup'));
    await context.close();
    await expect.poll(async () => (await service.snapshot()).runtime.activeRuns).toBe(0);
  }
}

try {
  for (const [profile, dimensions] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
    if (process.env.MUON_SCROLL_BROWSER_PROFILE && process.env.MUON_SCROLL_BROWSER_PROFILE !== profile) continue;
    for (const surface of ['chief', 'planning', 'comments', 'plan'] as const) {
      if (process.env.MUON_SCROLL_BROWSER_SURFACE && process.env.MUON_SCROLL_BROWSER_SURFACE !== surface) continue;
      await runSurface(profile, dimensions, surface);
    }
  }
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  assert.deepEqual(failures, [], 'Conversation scroll acceptance failures');
  assert.ok(checks.length > 0, 'At least one scenario must be selected');
  assert.equal(codex.calls.length, 0);
  succeeded = true;
} finally {
  await browser.close();
  await service.stop();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  repository.close();
  await writeFile(join(outputRoot, 'report.json'), JSON.stringify({ succeeded, fixture: 'Production bundle; isolated Chromium, HTTP, SQLite; controlled providers; dispatcher paused', filters: { profile: process.env.MUON_SCROLL_BROWSER_PROFILE ?? 'all', surface: process.env.MUON_SCROLL_BROWSER_SURFACE ?? 'all' }, limitations: ['Document visibility and mobile software-keyboard visual viewport events are simulated; no physical mobile keyboard was exercised.'], checks, failures, errors, measurements, screenshots }, null, 2));
  await writeFile(join(outputRoot, 'validation.md'), `Conversation scrolling browser acceptance ${succeeded ? 'passed' : 'failed'} with ${checks.length} checks (profile: ${process.env.MUON_SCROLL_BROWSER_PROFILE ?? 'all'}; surface: ${process.env.MUON_SCROLL_BROWSER_SURFACE ?? 'all'}). The complete matrix covers desktop and mobile Chief, quick planning chat, task Comments, and RFC discussion. It measures history anchors within 2px, own-send, failed-send/retry and delayed acknowledgement races, reconnect batching, unread navigation, reduced-motion focus, media/expansion/composer/viewport geometry, and navigation restoration. Document-hidden events and a 400px visual viewport with 24px offset are explicitly simulated; no physical mobile keyboard was exercised. No real model calls or owner data were used. See report.json for measurements and captured screenshots.\n`);
  console.log(JSON.stringify({ succeeded, outputRoot, checks: checks.length, failures: failures.length, errors }));
}
