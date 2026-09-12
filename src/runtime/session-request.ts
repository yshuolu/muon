import type {
  AgentPhase, AgentRequest, AgentSessionKind, AgentSessionRequest, SessionAccess,
} from './contracts.js';

const LEGACY_SESSIONS: Record<AgentPhase, AgentSessionKind> = {
  planning: 'plan',
  building: 'build',
  verification: 'verify',
  chief: 'chief',
  chat: 'chat',
};

const LEGACY_ACCESS: Record<AgentPhase, SessionAccess> = {
  planning: 'read-only',
  building: 'workspace-write',
  verification: 'workspace-write',
  chief: 'read-only',
  chat: 'read-only',
};

export interface NormalizedAgentRequest extends Omit<AgentSessionRequest, 'input'> {
  prompt: string;
  systemPrompt?: string;
  allowPermissionBypass: boolean;
}

/** Converts compatibility inputs once, before any provider access decisions. */
export function normalizeAgentRequest(request: AgentRequest | AgentSessionRequest): NormalizedAgentRequest {
  if ('session' in request) {
    const { input, ...execution } = request;
    if (request.session === 'chief' && request.access !== 'read-only') {
      throw new Error('The chief requires read-only repository access.');
    }
    return {
      ...execution,
      systemPrompt: input.systemPrompt,
      prompt: `Session instructions\n${input.instructions}\n\nTask context\n${input.context}`,
      allowPermissionBypass: request.access === 'workspace-write' && request.session !== 'chief',
    };
  }
  const { phase, ...execution } = request;
  return {
    ...execution,
    session: LEGACY_SESSIONS[phase],
    access: LEGACY_ACCESS[phase],
    allowPermissionBypass: phase !== 'chief',
  };
}
