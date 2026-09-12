import type { AgentAdapter, AgentRequest, WorkspaceProvider } from '../runtime';
import type { TaskService } from './task-service';
import type { Repository } from './ports';

export class DemoAdapter implements AgentAdapter {
  constructor(readonly provider: 'claude' | 'codex') {}
  async available() { return true; }
  async run(request: AgentRequest) {
    const sessionId = request.sessionId ?? `demo-${this.provider}-session`;
    request.onSessionId?.(sessionId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1700);
      request.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Demo run canceled.')); }, { once: true });
    });
    if (request.phase === 'discussion') return { text: 'Demo reply: your follow-up is saved in this task. This is an illustrative conversation; no real agent has inspected or changed your repository.', sessionId };
    if (request.phase === 'planning') {
      const result = { text: '# RFC: A focused, reviewable implementation\n\n> Demo content — no agent has run against your repository.\n\n## Problem\nMake the requested workflow clear, reliable, and easy to verify.\n\n## Proposed approach\nKeep task state in the domain layer, expose it through the local API, and render the final results in the workspace.\n\n## Implementation plan\n1. Extend the domain contract.\n2. Implement the behavior behind its existing interface.\n3. Connect the interface and cover meaningful edge cases.\n\n## Verification\nRun the focused tests and inspect the user flow. Attach observed results and screenshots.\n\n## Risks\nConcurrent updates must preserve the current approval and task state.' };
      if (request.prompt.includes('Return ONLY a JSON object with exactly {\"reply\":')) result.text = JSON.stringify({ reply: 'Demo reply: your comment is saved and a new illustrative RFC is ready. No real agent has run; use the local workspace to discuss your project with Claude or Codex.', content: result.text });
      return result;
    }
    if (request.phase === 'building') return { text: 'Demo implementation prepared. No repository files were changed.' };
    if (request.phase === 'verification') return { text: JSON.stringify({ summary: 'Demo workflow completed. These are illustrative results; no real tests were executed.', evidence: [{ kind: 'test', title: 'Illustrative workflow check', description: 'Demo evidence only. No real tests were executed.', result: 'passed', steps: ['Demo: create a task', 'Demo: approve the RFC', 'Demo: inspect the final results'] }] }) };
    return { text: 'This is the demo workspace. I can show how tasks move through planning, approval, and verification. Create a task and enable the dispatcher to try the workflow. Run Muon without `MUON_DEMO=1` to use your local Claude Code and Codex agents.' };
  }
}
export const demoWorkspaces: WorkspaceProvider = {
  async ensure({ taskId }) { return { path: `/demo/worktrees/${taskId}`, branch: `muon/${taskId.slice(0, 8)}`, baseCommit: 'demo' }; },
  async changedFiles() { return []; },
};

export async function seedDemo(service: TaskService, repo: Repository) {
  const scope = service.scope;
  if ((await repo.tasks(scope)).length) return;
  const planTask = await service.createTask({ title: 'Build the project command menu', description: 'A fast way to navigate the workspace without leaving the keyboard. Support task search, common actions, and a recent history.\n\n### Acceptance criteria\n- Open with the platform command shortcut\n- Search across task titles and identifiers\n- Navigate entirely with the keyboard\n- Return focus to the previous view when closed', priority: 2, labels: ['Experience'], provider: 'claude' });
  const plan = `# RFC: The project command menu\n\nA single entry point for moving through the workspace at the speed of thought.\n\n## Why this matters\nAs projects grow, finding the right task should stay effortless. A command menu makes navigation and common actions available from anywhere.\n\n## Proposed experience\nOpen the menu with **⌘ K** (or **Ctrl K**). Start typing to find tasks by title or identifier. Recent tasks appear immediately, followed by matching results.\n\n### Scope\n- Task search across this project\n- Quick actions: create a task, open attention, talk to the chief of staff\n- Arrow-key navigation with an obvious selection state\n- Escape closes the menu and restores focus\n\n## Implementation\nUse the existing dialog primitive for focus management. Keep search local and derive results from the same task records used by the list.\n\n| Area | Change |\n| --- | --- |\n| Command menu | Search input and result groups |\n| Keyboard shortcuts | Platform-aware global handler |\n| Navigation | Link results to task detail |\n\n## Verification plan\n1. Open and close with the keyboard.\n2. Search by title and task identifier.\n3. Navigate the full result set with arrow keys.\n4. Verify focus restoration and screen-reader labels.\n\n## Risks & boundaries\nAvoid intercepting shortcuts while typing in other fields. Search is scoped to the current project.\n\n---\n*Illustrative RFC from the Muon demo workspace.*`;
  await repo.saveTask(scope, { ...planTask, status: 'in_review', phase: 'plan_review', plans: [{ id: 'demo-plan-1', version: 1, format: 'markdown', content: plan, status: 'pending', createdAt: planTask.createdAt }] }, planTask.version);
  await repo.putAttention(scope, { id: `${planTask.id}:plan_approval`, taskId: planTask.id, kind: 'plan_approval', title: planTask.title, description: 'The proposed approach is ready for your review.', createdAt: planTask.createdAt });
  const parent = await service.createTask({ title: 'Make the workspace feel instant', description: 'Reduce friction in the everyday task experience.', priority: 2, labels: ['Experience'], status: 'backlog' });
  await service.createTask({ title: 'Persist task filters between visits', description: 'Remember the selected status filter and view preference.', priority: 3, labels: ['Polish'], provider: 'codex', parentId: parent.id });
  await service.createTask({ title: 'Add keyboard navigation to task lists', description: 'Move between tasks and open their details using the keyboard.', priority: 2, labels: ['Experience'], provider: 'claude', parentId: parent.id });
  await service.createTask({ title: 'Introduce a project activity digest', description: 'Summarize the final outcomes that matter to the project owner.', priority: 4, labels: ['Intelligence'], status: 'backlog' });
  const completed = await service.createTask({ title: 'Keep task workspaces isolated', description: 'Give every coding task a persistent worktree across all phases.', priority: 1, labels: ['Infrastructure'], provider: 'codex', status: 'backlog' });
  await repo.saveTask(scope, { ...completed, status: 'done', phase: 'complete', completedAt: completed.createdAt, summary: 'Each coding task keeps a dedicated branch and worktree through planning, building, and verification. Demo result; no real work ran.', evidence: [{ id: 'demo-test', kind: 'test', title: 'Worktree lifecycle', description: 'Illustrative passing checks for the demo. No real tests were executed.', result: 'passed', steps: ['Create two tasks in the same repository', 'Verify different worktree directories and branches', 'Resume a task and verify it reuses the same directory'], createdAt: completed.createdAt }], changedFiles: [{ path: 'src/runtime/local-worktree-provider.ts', status: 'added', additions: 142, deletions: 0 }, { path: 'src/runtime/contracts.ts', status: 'modified', additions: 18, deletions: 2 }] }, completed.version);
  await repo.putAttention(scope, { id: `${completed.id}:completed`, taskId: completed.id, kind: 'completed', title: completed.title, description: 'Ready for your review. Verification evidence and changed files are attached.', createdAt: completed.createdAt });
  await repo.appendMessage(scope, { id: 'demo-chief-welcome', role: 'assistant', content: 'Your workspace is ready. **One RFC needs your review**, and the worktree isolation task has verification evidence to inspect.\n\nThe next two tasks are queued for the dispatcher. This is a demo workspace with illustrative results — your real repositories are untouched.', createdAt: new Date().toISOString(), taskIds: [planTask.id, completed.id] });
}
