import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { createNdjsonParser, encodeNdjson } from './ndjson-framer.js';
import { AgentProcessUnreapedError } from './agent-process-error.js';

const exec = promisify(execFile);

export async function executableAvailable(executable: string, prefixArgs: string[] = []): Promise<boolean> {
  try {
    await exec(executable, [...prefixArgs, '--version'], { timeout: 5_000, windowsHide: true, maxBuffer: 8_192 });
    return true;
  } catch {
    return false;
  }
}

export async function validateWorkingDirectory(cwd: string): Promise<void> {
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
    throw new Error('Agent working directory must be an existing absolute directory.');
  }
}

export function aborted(): Error {
  const error = new Error('Agent run cancelled.');
  error.name = 'AbortError';
  return error;
}

// Adapted from Orca's codex-app-server-session.ts: framed stdio, bounded stderr, EOF/reap.
export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = '';
  private closed = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private readonly exit: Promise<void>;

  constructor(input: {
    executable: string;
    args: string[];
    cwd: string;
    signal?: AbortSignal;
    onRecord: (value: unknown) => void;
    onFault: (error: Error) => void;
  }) {
    if (input.signal?.aborted) throw aborted();
    this.child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
    });
    const fault = (error: Error) => {
      if (!this.stopping) input.onFault(error);
    };
    const parser = createNdjsonParser(input.onRecord, (error) => {
      fault(new Error(`Invalid agent protocol output: ${error.message}`));
    });
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      try { parser.feed(chunk); } catch (error) {
        fault(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stdout.on('end', () => {
      try { parser.feed('\n'); } catch (error) {
        fault(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8_192);
    });
    this.child.stdin.on('error', fault);
    this.child.on('error', fault);
    const onAbort = () => fault(aborted());
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => fault(new Error('Agent exceeded the 30 minute run deadline.')), 30 * 60_000);
    deadline.unref();
    this.exit = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.closed = true;
        clearTimeout(deadline);
        input.signal?.removeEventListener('abort', onAbort);
        fault(new Error(`Agent exited before completing its result (${signal ?? code ?? 'unknown'}).${this.stderrTail.trim() ? ` ${this.stderrTail.trim()}` : ''}`));
        resolve();
      });
    });
    if (input.signal?.aborted) onAbort();
  }

  send(value: Record<string, unknown>): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Agent connection is closed.');
    this.child.stdin.write(encodeNdjson(value));
  }

  writePrompt(prompt: string): void {
    this.child.stdin.end(prompt);
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopAndWait();
    return this.stopPromise;
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.closed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exit, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    })]);
    if (timer) clearTimeout(timer);
  }

  private signalTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid && process.platform !== 'win32') {
      try { process.kill(-pid, signal); return; } catch { /* Root handle remains the fallback. */ }
    }
    if (pid && process.platform === 'win32' && signal === 'SIGKILL') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', shell: false });
      killer.on('error', () => this.child.kill(signal));
      killer.unref();
    }
    this.child.kill(signal);
  }

  private groupExists(): boolean {
    if (process.platform === 'win32' || !this.child.pid) return !this.closed;
    try { process.kill(-this.child.pid, 0); return true; } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async waitForShutdown(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.waitForExit(timeoutMs);
    // The root CLI can exit before a shell or test server in its process group.
    while (this.groupExists()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
  }

  private async stopAndWait(): Promise<void> {
    this.stopping = true;
    this.child.stdin.end();
    await this.waitForExit(150);
    // POSIX children share this run's dedicated process group, even if the CLI exited first.
    this.signalTree('SIGTERM');
    await this.waitForShutdown(750);
    if (this.groupExists()) {
      this.signalTree('SIGKILL');
      await this.waitForShutdown(1_000);
    }
    if (!this.closed || this.groupExists()) throw new AgentProcessUnreapedError();
  }
}
