export class AgentProcessUnreapedError extends Error {
  readonly code = 'AGENT_PROCESS_UNREAPED' as const;

  constructor() {
    super('Agent process did not stop; its execution slot cannot be reused safely. Stop the process manually before restarting Muon.');
    this.name = 'AgentProcessUnreapedError';
  }
}
