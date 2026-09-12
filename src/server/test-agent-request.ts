import { normalizeAgentRequest } from '../runtime';
import type { AgentRequest, AgentSessionKind, AgentSessionRequest, NormalizedAgentRequest, SessionInput } from '../runtime';

type ObservedPhase = AgentRequest['phase'] | 'brainstorming' | 'researching';
const SESSION_PHASES: Record<AgentSessionKind, ObservedPhase> = {
  brainstorm: 'brainstorming', research: 'researching', plan: 'planning',
  build: 'building', verify: 'verification', chief: 'chief', chat: 'chat',
};

/** Keeps existing phase assertions readable while retaining the actual session input. */
export interface ObservedAgentRequest extends NormalizedAgentRequest {
  phase: ObservedPhase;
  input?: SessionInput;
  original: AgentRequest | AgentSessionRequest;
}

export function observeAgentRequest(original: AgentRequest | AgentSessionRequest): ObservedAgentRequest {
  const normalized = normalizeAgentRequest(original);
  return {
    ...normalized,
    phase: SESSION_PHASES[normalized.session],
    ...('input' in original ? { input: original.input } : {}),
    original,
  };
}
