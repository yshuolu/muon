import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { serve } from '@hono/node-server';
import { LocalWorktreeProvider, type AgentAdapter, type AgentRequest, type AgentResult } from '../src/runtime';
import { TaskService } from '../src/server/task-service';
import { LocalChiefCommands } from '../src/server/local-chief-commands';
import { SqliteRepository } from '../src/server/sqlite-repository';
import { LocalArtifactStore } from '../src/server/local-artifacts';
import { createHttpApp } from '../src/server/http-app';
import { singleProjectResolver } from '../src/server/project-registry';
import type { Task } from '../src/shared/types';

// Dedicated headless browser, isolated SQLite, and real HTTP/Git/artifact storage.
// Provider outcomes are controlled: this validates product behavior, not live model execution.
class ControlledAdapter implements AgentAdapter {
  calls: { request: AgentRequest; finish: (text: string) => void; fail: (error: Error) => void }[] = [];
  constructor(readonly provider: 'claude' | 'codex') {}
  async available() { return true; }
  run(request: AgentRequest): Promise<AgentResult> {
    return new Promise((resolveRun, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Acceptance fixture stopped')), { once: true });
      this.calls.push({ request, finish: text => resolveRun({ text, sessionId: `browser-fixture-${this.calls.length}` }), fail: reject });
    });
  }
}

const exec = promisify(execFile);
await mkdir(resolve('.muon/validation'), { recursive: true });
const outputRoot = await mkdtemp(resolve('.muon/validation/browser-'));
const repoPath = join(outputRoot, 'repository');
await mkdir(repoPath);
await writeFile(join(repoPath, 'README.md'), '# Browser acceptance fixture\n');
await writeFile(join(repoPath, '.gitignore'), '.muon-evidence/\n');
async function git(...args: string[]) { return (await exec('git', ['-C', repoPath, ...args])).stdout; }
await git('init');
await git('config', 'user.name', 'Muon browser acceptance');
await git('config', 'user.email', 'browser-test@localhost');
await git('config', 'core.hooksPath', join(outputRoot, 'empty-hooks'));
await git('add', '.');
await git('commit', '-m', 'Initialize isolated browser acceptance repository');

const scope = { workspaceId: 'browser-acceptance', projectId: 'isolated-project', userId: 'test-owner' };
const databasePath = join(outputRoot, 'muon.sqlite');
const repository = new SqliteRepository(databasePath);
await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, ownerUserId: scope.userId, name: 'Browser acceptance fixture', identifier: 'UI', repositoryPath: repoPath }, { defaultProvider: 'claude', dispatcherEnabled: false, maxConcurrentAgents: 1 });
const claude = new ControlledAdapter('claude');
const codex = new ControlledAdapter('codex');
const artifacts = new LocalArtifactStore(join(outputRoot, 'artifacts'));
const workspaces = new LocalWorktreeProvider(join(outputRoot, 'worktrees'));
const port = Number(process.env.MUON_BROWSER_TEST_PORT ?? 4332);
const commands = new LocalChiefCommands({ apiUrl: `http://127.0.0.1:${port}`, scope });
const service = new TaskService({ scope, repository, artifacts, workspaces, adapters: { claude, codex }, chiefCommands: commands });
await service.initialize();
service.start();
const url = `http://127.0.0.1:${port}`;
const app = createHttpApp(singleProjectResolver(service), artifacts, { port, staticRoot: resolve('dist'), access: commands });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
const browser = await chromium.launch({ headless: true });
const screenshots: string[] = [];
const checks: string[] = [];
const errors: string[] = [];
let context: BrowserContext | undefined;
let succeeded = false;
const check = (text: string) => { checks.push(text); console.log(`PASS ${text}`); };
const observeErrors = (page: Page) => { page.on('pageerror', error => errors.push(error.message)); };
async function taskByTitle(title: string) {
  let result: Task | undefined;
  await expect.poll(async () => { result = (await repository.tasks(scope)).find(task => task.title === title); return Boolean(result); }, { timeout: 10000 }).toBe(true);
  return result!;
}
async function call(index: number, phase: AgentRequest['phase']) {
  await expect.poll(() => claude.calls.length, { timeout: 10000 }).toBeGreaterThan(index);
  assert.equal(claude.calls[index].request.phase, phase);
  return claude.calls[index];
}
async function waitTask(id: string, status: Task['status']) {
  await expect.poll(async () => (await service.getTask(id)).status, { timeout: 10000 }).toBe(status);
  return service.getTask(id);
}
async function capture(page: Page, name: string) {
  const path = join(outputRoot, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' }); screenshots.push(path); return path;
}

try {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: join(outputRoot, 'recordings'), size: { width: 1440, height: 1000 } } });
  context.setDefaultTimeout(10000);
  let page = await context.newPage(); observeErrors(page);
  const video = page.video()!;
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'All tasks', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Planning thread', exact: true })).toBeVisible();
  await page.getByLabel('Message your planning partner', { exact: true }).fill('I want a task group for browser acceptance work.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const planningChat = await call(0, 'chat');
  planningChat.finish('A task group with browser acceptance coverage is a good shape.');
  await expect(page.getByText('A task group with browser acceptance coverage is a good shape.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Taskify conversation', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Browser acceptance group');
  await page.getByRole('combobox', { name: 'Task type', exact: true }).selectOption('group');
  await page.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('2');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const group = await taskByTitle('Browser acceptance group');
  assert.equal(group.kind, 'group'); assert.equal(claude.calls.length, 1);
  await expect(page.getByRole('button', { name: 'Add subtask', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toHaveCount(0);
  check('Task groups are created through the UI and have no agent, RFC, or fabricated verification.');

  await page.getByRole('button', { name: 'Add subtask', exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill('Verify task media and recovery');
  await page.getByLabel('Description', { exact: true }).fill('Controlled browser fixture: verify the owner RFC gate, repair flow, screenshots, and recordings.');
  await expect(page.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const child = await taskByTitle('Verify task media and recovery');
  assert.equal(child.parentId, group.id);
  await expect(page.locator('.queue-explanation').getByText('Automatic dispatch is paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume dispatcher', exact: true }).click();
  const planning = await call(1, 'planning');
  planning.finish('# RFC: task media and recovery\n\n## Approach\nWrite a fixture result in result.txt inside this task worktree.\n\n## Acceptance\n- Owner approval is mandatory.\n- Capture an actual browser screenshot and recording.\n- Failed verification is repaired, then verified again.\n\n## Verification\nCheck the real browser UI, download the media, and seek the recording.');
  await waitTask(child.id, 'in_review');
  await expect(page.getByRole('tab', { name: /Plan/ })).toBeVisible();
  await page.getByRole('tab', { name: /Plan/ }).click();
  await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeVisible();
  assert.equal(claude.calls.length, 2);
  const gate = await fetch(`${url}/api/tasks/${child.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
  assert.equal(gate.status, 400);
  await capture(page, '01-rfc-review');
  check('Subtask priority and parent persist; pause is explained; building cannot launch before explicit owner approval.');

  await expect(page.getByRole('button', { name: 'Request changes', exact: true })).toHaveCount(0);
  const initialPlan = (await service.getTask(child.id)).plans.at(-1)!;
  await page.getByLabel('Comment on the plan', { exact: true }).fill('Please explain how the screenshot proves the result and include keyboard navigation in verification.');
  await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeDisabled();
  await page.route(`**/tasks/${child.id}/plan-discussion`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This task changed. Refresh and try again.' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This task changed. Refresh and try again.' }).first()).toBeVisible();
  await expect(page.getByLabel('Comment on the plan', { exact: true })).toHaveValue('Please explain how the screenshot proves the result and include keyboard navigation in verification.');
  assert.equal((await service.getTask(child.id)).planDiscussion?.length ?? 0, 0);
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  const revisionOne = await call(2, 'planning');
  assert.match(revisionOne.request.prompt, /include keyboard navigation/);
  await expect(page.getByLabel('Comment on the plan', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeDisabled();
  const obsoleteApproval = await fetch(`${url}/api/tasks/${child.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: initialPlan.id }) });
  assert.equal(obsoleteApproval.status, 409);
  revisionOne.finish(JSON.stringify({ reply: 'The screenshot records the visible workflow state; keyboard navigation will be checked separately and recorded in the test steps.', content: '# RFC: task media and recovery\n\n## Approach\nWrite result.txt inside this worktree.\n\n## Verification\nCapture the actual workflow screenshot and recording. Check keyboard navigation separately and record the observed test steps. Repair any failed checks within scope.' }));
  const firstRevision = await waitTask(child.id, 'in_review');
  await expect(page.getByRole('combobox', { name: 'Plan version', exact: true })).toHaveValue(firstRevision.plans.at(-1)!.id);
  await expect(page.getByText('The screenshot records the visible workflow state; keyboard navigation will be checked separately and recorded in the test steps.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Plan version', exact: true }).selectOption(initialPlan.id);
  await expect(page.getByLabel('Comment on the plan', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Plan version', exact: true }).selectOption(firstRevision.plans.at(-1)!.id);
  await page.getByLabel('Comment on the plan', { exact: true }).fill('Keep those checks, and explicitly verify focus returns after the screenshot dialog closes.');
  await page.getByRole('button', { name: 'Send comment', exact: true }).click();
  const revisionTwo = await call(3, 'planning');
  assert.match(revisionTwo.request.prompt, /include keyboard navigation/);
  assert.match(revisionTwo.request.prompt, /screenshot records the visible workflow state/);
  assert.match(revisionTwo.request.prompt, /focus returns/);
  revisionTwo.finish(JSON.stringify({ reply: 'Kept keyboard navigation and added a focus-restoration check after closing the screenshot dialog.', content: '# RFC: task media and recovery\n\n## Approach\nWrite result.txt inside this worktree.\n\n## Verification\nCheck keyboard navigation and focus restoration after closing the screenshot dialog. Capture the actual screenshot and recording. Repair any failed checks within the approved scope.' }));
  const revisedReview = await waitTask(child.id, 'in_review');
  assert.equal(revisedReview.plans.length, 3);
  assert.equal(revisedReview.planDiscussion?.length, 4);
  assert.deepEqual(revisedReview.runs!.map(run => run.phase), ['planning', 'planning', 'planning']);
  await page.reload();
  await expect(page.getByRole('heading', { name: child.title, exact: true })).toBeVisible();
  await expect(page.getByText('Kept keyboard navigation and added a focus-restoration check after closing the screenshot dialog.', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Plan version', exact: true })).toHaveValue(revisedReview.plans.at(-1)!.id);
  await capture(page, '01b-plan-conversation');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Comment on the plan', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Comment on the plan', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await capture(page, '01c-plan-conversation-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  check('Two plan comments preserve conversation and RFC versions across reloads; rejected sends retain the draft, stale revisions cannot be approved, and review controls work on mobile.');

  await page.getByRole('button', { name: 'Close task', exact: true }).click();
  await page.getByRole('button', { name: /^Attention \d/ }).click();
  await page.getByRole('button', { name: 'Review plan', exact: true }).click();
  await expect(page.locator('.detail-breadcrumb').getByRole('button', { name: 'All tasks', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
  const building = await call(4, 'building');
  assert.match(building.request.prompt, /focus restoration/);
  await writeFile(join(building.request.cwd, 'result.txt'), 'Acceptance fixture result, first implementation.\n');
  building.finish('Created result.txt in the isolated worktree.');
  const firstVerification = await call(5, 'verification');
  firstVerification.finish(JSON.stringify({ summary: 'Controlled first verification requires repair.', evidence: [{ kind: 'test', title: 'Initial fixture check', description: 'Controlled failure exercises the repair interface.', result: 'failed', steps: ['Inspect first implementation', 'Report the controlled failing check'] }] }));
  await waitTask(child.id, 'blocked');
  await expect(page.getByRole('combobox', { name: 'Next step', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Next step', exact: true }).selectOption('fix');
  await page.getByLabel('What should the agent address?', { exact: true }).fill('Correct the fixture output without changing the approved scope.');
  await capture(page, '02-recovery-controls');
  await page.getByRole('button', { name: 'Fix and verify', exact: true }).click();
  const repairing = await call(6, 'building');
  assert.match(repairing.request.prompt, /Correct the fixture output/);
  await writeFile(join(repairing.request.cwd, 'result.txt'), 'Acceptance fixture result, corrected implementation.\n');
  repairing.finish('Corrected result.txt within the approved RFC.');
  const finalVerification = await call(7, 'verification');
  const evidenceDir = join(finalVerification.request.cwd, '.muon-evidence');
  await mkdir(evidenceDir);
  const actualScreenshot = join(evidenceDir, 'workflow.png');
  await page.screenshot({ path: actualScreenshot, fullPage: true });
  await context.close(); context = undefined;
  const recordedPath = await video.path();
  const actualRecording = join(evidenceDir, 'workflow.webm');
  await copyFile(recordedPath, actualRecording);
  assert.ok((await stat(actualScreenshot)).size > 1000); assert.ok((await stat(actualRecording)).size > 1000);
  finalVerification.finish(JSON.stringify({ summary: 'Controlled browser fixture finished. Screenshots and recordings below were captured from the actual rendered application; provider outcomes were controlled by the test.', evidence: [
    { kind: 'test', title: 'Browser workflow check', description: 'Owner approval and approved-scope repair were exercised through browser controls.', result: 'passed', steps: ['Create group and subtask', 'Review and approve the RFC', 'Inspect failed verification', 'Request repair within the approved scope'] },
    { kind: 'screenshot', title: 'Actual workflow screenshot', description: 'Actual browser capture of this controlled acceptance fixture.', artifactPath: '.muon-evidence/workflow.png' },
    { kind: 'recording', title: 'Actual workflow recording', description: 'Actual browser recording of group creation, owner approval, and repair.', artifactPath: '.muon-evidence/workflow.webm' },
  ] }));
  const completed = await waitTask(child.id, 'done');
  await waitTask(group.id, 'done');
  assert.equal(completed.plans.length, 3); assert.equal(completed.evidence.length, 4);
  assert.equal((await git('status', '--porcelain')).trim(), '');
  check('Repair preserves the approved RFC; real Git changes and actual browser screenshot/video are imported through TaskService and LocalArtifactStore.');

  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  context.setDefaultTimeout(10000);
  page = await context.newPage(); observeErrors(page);
  await page.goto(url);
  await page.getByRole('button').filter({ hasText: child.title }).click();
  await expect(page.getByText('1 passed', { exact: true })).toBeVisible();
  await expect(page.getByText('0 failed', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Verification attempt', exact: true }).selectOption(completed.runs!.filter(run => run.phase === 'verification')[0].id);
  await expect(page.getByText('1 failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier verification', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Verification attempt', exact: true }).selectOption('latest');
  await expect(page.getByText('0 failed', { exact: true })).toBeVisible();
  check('Latest evidence excludes historical failures, and the prior failed attempt remains reviewable.');

  const screenshotCard = page.locator('.evidence-card').filter({ has: page.getByRole('heading', { name: 'Actual workflow screenshot', exact: true }) });
  await expect.poll(() => screenshotCard.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await screenshotCard.getByRole('button', { name: 'Expand Actual workflow screenshot', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await capture(page, '03-expanded-screenshot');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const recordingCard = page.locator('.evidence-card').filter({ has: page.getByRole('heading', { name: 'Actual workflow recording', exact: true }) });
  const player = recordingCard.locator('video');
  await player.scrollIntoViewIfNeeded();
  await expect.poll(() => player.evaluate(video => (video as HTMLVideoElement).readyState), { timeout: 10000 }).toBeGreaterThanOrEqual(1);
  const duration = await player.evaluate(video => (video as HTMLVideoElement).duration);
  assert.ok(Number.isFinite(duration) && duration > 0);
  await player.evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; await video.play(); });
  await expect.poll(() => player.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
  const target = Math.min(duration / 2, 2);
  await player.evaluate((element, seekTo) => { const video = element as HTMLVideoElement; video.pause(); video.currentTime = seekTo; }, target);
  await expect.poll(() => player.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeCloseTo(target, 1);
  assert.equal(await player.evaluate(video => (video as HTMLVideoElement).error), null);
  const recording = completed.evidence.find(item => item.kind === 'recording')!;
  const range = await fetch(`${url}${recording.artifactUrl}`, { headers: { range: 'bytes=10-99' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 90);
  const downloadEvent = page.waitForEvent('download');
  await recordingCard.getByRole('link', { name: 'Download', exact: true }).click();
  const download = await downloadEvent;
  const downloadedPath = join(outputRoot, 'downloaded-recording.webm'); await download.saveAs(downloadedPath);
  assert.equal((await stat(downloadedPath)).size, (await stat(actualRecording)).size);
  await capture(page, '04-recording-playback');
  check('Original screenshot renders and expands; actual video loads, plays, seeks, serves HTTP byte ranges, and downloads unchanged.');

  await page.getByRole('tab', { name: /^Changes/ }).click();
  await expect(page.getByText('result.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close task', exact: true }).click();
  await page.getByRole('button').filter({ hasText: group.title }).click();
  await expect(page.locator('.detail-footer').getByText('All subtasks completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Evidence/ })).toHaveCount(0);
  await capture(page, '05-group-completed');
  await service.updateSettings({ dispatcherEnabled: false });
  const excluded = await service.createTask({ title: 'Canceled scope decision', parentId: group.id, status: 'backlog' });
  await service.editTask(excluded.id, { status: 'canceled' });
  await waitTask(group.id, 'todo');
  await expect(page.getByText(/canceled subtask.*require a scope decision/)).toBeVisible();
  await page.locator('.task-detail .subtask-list').getByRole('button').filter({ hasText: excluded.title }).click();
  await page.getByRole('button', { name: 'Remove from parent', exact: true }).click();
  await expect.poll(async () => (await service.getTask(excluded.id)).parentId).toBe(null);
  assert.equal((await service.getTask(excluded.id)).status, 'canceled');
  await waitTask(group.id, 'done');
  check('Files list uses actual worktree changes; group rollup reopens for new children and handles canceled scope removal without inventing success.');

  const integration = await service.createTask({ title: 'Review frozen dependency input', status: 'todo', blockedByIds: [child.id] });
  await service.updateSettings({ dispatcherEnabled: true });
  const integrationPlan = await call(8, 'planning');
  integrationPlan.finish('# Integration RFC\n\nUse the frozen result.txt patch from the completed dependency.\n\nThe owner reviews these exact inputs before implementation.');
  const integrationReview = await waitTask(integration.id, 'in_review');
  assert.equal(integrationReview.plans[0].dependencyInputs?.length, 1);
  await page.getByRole('button', { name: /^All tasks \d/ }).click();
  await page.getByRole('button').filter({ hasText: integration.title }).click();
  await page.getByRole('tab', { name: /^Plan/ }).click();
  await page.locator('.plan-dependencies summary').click();
  await expect(page.locator('.plan-dependency-files').getByText('result.txt', { exact: true })).toBeVisible();
  const patchDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download reviewed patch', exact: true }).click();
  const patchDownload = await patchDownloadEvent;
  const patchPath = join(outputRoot, 'reviewed-dependency.patch'); await patchDownload.saveAs(patchPath);
  const frozen = integrationReview.plans[0].dependencyInputs![0].changes;
  const expectedPatch = Buffer.from(frozen.patch, frozen.patchEncoding === 'base64' ? 'base64' : 'utf8');
  assert.deepEqual(await readFile(patchPath), expectedPatch);
  await capture(page, '06-frozen-dependency-inputs');
  check('Integration RFCs show immutable dependency file snapshots and download the exact reviewed patch bytes.');

  await page.getByRole('button', { name: 'Chief of staff', exact: true }).click();
  await page.getByLabel('Message your chief of staff', { exact: true }).fill('Capture a backlog follow-up for this fixture.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const chief = await call(9, 'chief');
  await exec(process.execPath, [resolve('bin/muon.mjs'), 'tasks', 'create', '--json', JSON.stringify({ title: 'Fixture follow-up', status: 'backlog' })], { env: { ...process.env, MUON_API_URL: url, MUON_API_TOKEN: chief.request.chiefCli!.token, MUON_PROJECT: scope.projectId } });
  chief.finish('Captured the follow-up in the backlog.');
  await expect(page.getByRole('button').filter({ hasText: 'Fixture follow-up' })).toBeVisible();
  await page.getByRole('button').filter({ hasText: 'Fixture follow-up' }).click();
  await expect(page.locator('.detail-breadcrumb').getByRole('button', { name: 'All tasks', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Message your chief of staff', { exact: true })).toBeVisible();
  check('Chief CLI operations create persisted task links and browser Back returns to the Chief conversation.');
  assert.deepEqual(errors, []);
  check('No browser page errors were observed.');
  succeeded = true;
} catch (error) {
  const failedPage = context?.pages()[0];
  if (failedPage) { await failedPage.screenshot({ path: join(outputRoot, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(outputRoot, 'failure-dom.html'), await failedPage.content()).catch(() => {}); }
  throw error;
} finally {
  await context?.close();
  await browser.close();
  for (const pending of claude.calls) pending.fail(new Error('Acceptance fixture cleanup'));
  await service.stop();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  repository.close();
  const reopened = new SqliteRepository(databasePath);
  const saved = await reopened.tasks(scope); reopened.close();
  if (succeeded) { assert.ok(saved.some(task => task.status === 'done' && task.evidence.some(item => item.kind === 'recording') && task.planDiscussion?.length === 4 && task.plans.length === 3)); check('SQLite reopen retains the completed task, RFC discussion and revisions, attempt history, and media references.'); }
  await writeFile(join(outputRoot, 'report.json'), JSON.stringify({ succeeded, checks, errors, screenshots, outputRoot }, null, 2));
  if (succeeded) {
    await writeFile(resolve('docs/browser-validation.md'), `# Browser acceptance validation\n\nPassed ${new Date().toISOString()}.\n\nThis is an isolated product acceptance fixture with controlled agent outcomes, real HTTP and SQLite, real Git worktrees, and a dedicated headless Chromium browser. It does not claim authenticated Claude/Codex execution. No user browser tab or project database was used.\n\n${checks.map(item => `- ${item}`).join('\n')}\n\n## Retained artifacts\n\n- Fixture database, Git repository, worktrees, imported artifacts, and JSON report: \`${outputRoot}\`\n- Full browser recording: \`${join(outputRoot, 'recordings')}\`\n- Downloaded original recording: \`${join(outputRoot, 'downloaded-recording.webm')}\`\n${screenshots.map(path => `- [${path.split('/').at(-1)}](${path})`).join('\n')}\n\nRerun after building: \`npx tsx scripts/browser-live-check.ts\`. Install the dedicated Chromium test runtime once with \`npx playwright install chromium\`.\n`);
  }
  if (succeeded) {
    const generatedValidationPath = resolve('docs/browser-validation.md');
    const generatedValidation = await readFile(generatedValidationPath, 'utf8');
    await writeFile(generatedValidationPath, generatedValidation.replaceAll('npx tsx scripts/browser-live-check.ts', 'pnpm exec tsx scripts/browser-live-check.ts').replaceAll('npx playwright install chromium', 'pnpm exec playwright install chromium'));
  }
  console.log(JSON.stringify({ succeeded, outputRoot, checks: checks.length, errors }));
}
