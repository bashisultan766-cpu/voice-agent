export interface CallSession {
  id: string;
  status: string;
  agentId: string;
  startedAt?: string;
  endedAt?: string;
}
