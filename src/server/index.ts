import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { ClaudeCodeAdapter, CodexAdapter, LocalWorktreeProvider } from '../runtime';
import { SqliteRepository } from './sqlite-repository';
import { LocalArtifactStore } from './local-artifacts';
import { LocalAssetStorage } from './local-assets';
import { AssetService } from './asset-service';
import { TaskService } from './task-service';
import { createHttpApp } from './http-app';
import { DemoAdapter, demoWorkspaces, seedDemo } from './demo';
import { LocalIdentityProvider } from './local-identity';
import { acquireLocalInstance } from './local-instance-lock';
import { LocalChiefCommands } from './local-chief-commands';

const demo = process.env.MUON_DEMO === '1';
const port = Number(process.env.PORT ?? 4310);
const bypassAgentPermissions = process.env.MUON_AGENT_BYPASS_PERMISSIONS !== '0';
const dataRoot = resolve(process.env.MUON_DATA_DIR ?? '.muon', demo ? 'demo' : 'local');
const releaseInstance = await acquireLocalInstance(dataRoot);
const scope = new LocalIdentityProvider().currentScope();
const chiefCommands = new LocalChiefCommands({ apiUrl: `http://127.0.0.1:${port}`, scope });
const repository = new SqliteRepository(resolve(dataRoot, 'muon.sqlite'));
const artifacts = new LocalArtifactStore(resolve(dataRoot, 'artifacts'));
const assets = new AssetService({ repository, storage: new LocalAssetStorage(resolve(dataRoot, 'assets')), legacyArtifacts: artifacts });
const service = new TaskService({ scope, repository, artifacts, assets, demo, chiefCommands,
  adapters: demo ? { claude: new DemoAdapter('claude'), codex: new DemoAdapter('codex') } : {
    claude: new ClaudeCodeAdapter(process.env.MUON_CLAUDE_EXECUTABLE, {
      model: process.env.MUON_CLAUDE_MODEL ?? 'claude-fable-5-1[1m]',
      effort: process.env.MUON_CLAUDE_EFFORT ?? 'max',
      allowedNetworkDomains: process.env.MUON_CLAUDE_ALLOWED_DOMAINS?.split(',').map(domain => domain.trim()).filter(Boolean),
      allowLocalBinding: process.env.MUON_CLAUDE_ALLOW_LOCAL_SERVERS === '1',
      bypassPermissions: bypassAgentPermissions,
    }),
    codex: new CodexAdapter(process.env.MUON_CODEX_EXECUTABLE, {
      model: process.env.MUON_CODEX_MODEL ?? 'gpt-6-astra',
      reasoningEffort: process.env.MUON_CODEX_REASONING_EFFORT ?? 'ultra',
      bypassPermissions: bypassAgentPermissions,
    }),
  },
  workspaces: demo ? demoWorkspaces : new LocalWorktreeProvider(resolve(dataRoot, 'worktrees')),
});
let ready = false;
const app = createHttpApp(service, artifacts, { port, ready: () => ready, access: chiefCommands });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  void (async () => {
    await repository.initialize(scope, { id: scope.projectId, workspaceId: scope.workspaceId, name: demo ? 'Muon' : 'My project', identifier: 'MUO', repositoryPath: demo ? '/demo/project' : process.env.MUON_REPOSITORY_PATH ?? '', ownerUserId: scope.userId }, { maxConcurrentAgents: 2, dispatcherEnabled: !demo, defaultProvider: 'claude' });
    await service.initialize();
    if (demo) await seedDemo(service, repository);
    ready = true; service.start();
    console.log(`Muon ${demo ? 'demo ' : ''}is ready at http://127.0.0.1:${port}`);
  })().catch(async error => { console.error(error); server.close(); await releaseInstance(); repository.close(); process.exitCode = 1; });
});
server.on('error', error => { console.error(error); void releaseInstance(); repository.close(); process.exitCode = 1; });
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; ready = false;
  await service.stop();
  await releaseInstance();
  server.close(() => { repository.close(); process.exit(0); });
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
