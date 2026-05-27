import type { AgentApi } from '@/lib/api/agents';

/** Strip non-JSON values before crossing the Server → Client boundary. */
export function normalizeAgentForClient(agent: AgentApi | null | undefined): AgentApi | null {
  if (!agent) return null;
  return JSON.parse(JSON.stringify(agent)) as AgentApi;
}
