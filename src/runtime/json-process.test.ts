import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentProcessUnreapedError } from './agent-process-error.js';
import { JsonProcess } from './json-process.js';

describe('JsonProcess shutdown contract', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('marks an unconfirmed process exit so the dispatcher cannot recycle its slot', async () => {
    // Exercise the timeout branch without creating a real process that cannot be killed.
    const connection = Object.assign(Object.create(JsonProcess.prototype), {
      child: { stdin: { end: vi.fn() }, kill: vi.fn(), pid: undefined },
      closed: false,
      waitForExit: vi.fn(async () => undefined),
    }) as JsonProcess;
    const stopped = expect(connection.stop()).rejects.toBeInstanceOf(AgentProcessUnreapedError);
    await vi.runAllTimersAsync();
    await stopped;
    await expect(connection.stop()).rejects.toMatchObject({ code: 'AGENT_PROCESS_UNREAPED' });
  });

  it('retains the slot when the CLI has exited but its process group still survives termination', async () => {
    const signalTree = vi.fn();
    const connection = Object.assign(Object.create(JsonProcess.prototype), {
      child: { stdin: { end: vi.fn() } },
      closed: true,
      waitForExit: vi.fn(async () => undefined),
      signalTree,
      groupExists: vi.fn(() => true),
    }) as JsonProcess;
    const stopped = expect(connection.stop()).rejects.toBeInstanceOf(AgentProcessUnreapedError);
    await vi.runAllTimersAsync();
    await stopped;
    expect(signalTree.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('confirms descendant termination before recycling an already-exited CLI slot', async () => {
    let groupAlive = true;
    const signalTree = vi.fn((signal: string) => {
      if (signal === 'SIGKILL') setTimeout(() => { groupAlive = false; }, 100);
    });
    const connection = Object.assign(Object.create(JsonProcess.prototype), {
      child: { stdin: { end: vi.fn() } },
      closed: true,
      waitForExit: vi.fn(async () => undefined),
      signalTree,
      groupExists: vi.fn(() => groupAlive),
    }) as JsonProcess;
    let finished = false;
    const stopped = connection.stop().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(800);
    expect(finished).toBe(false);
    await vi.runAllTimersAsync();
    await stopped;
    expect(groupAlive).toBe(false);
    expect(finished).toBe(true);
  });
});
