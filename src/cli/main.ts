import { runCli } from './cli';
import { ApiError } from '../shared/api-client';
import { createCliTransport, type CliTransport } from './transport';

let transport: CliTransport | undefined;
try {
  transport = createCliTransport(process.env);
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env, cwd: process.cwd(), fetch: transport.fetch,
    stdout: value => { process.stdout.write(value); },
    stderr: value => { process.stderr.write(value); },
    stdin: async () => {
      if (process.stdin.isTTY) throw new Error('Standard input is a terminal.');
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8');
    },
  });
} catch (error) {
  const failure = error instanceof ApiError ? error : new ApiError('The CLI transport could not start.', 0, 'transport_error');
  process.stderr.write(JSON.stringify({ error: { code: failure.code, message: failure.message, status: failure.status } }) + '\n');
  process.exitCode = 1;
} finally {
  await transport?.close();
}
