import type { VoiceTurnOutput, AgentTaskResult } from '../../types/voice-turn.types';

export type MockOrchestratorCall = {
  callSessionId: string;
  utterance: string;
  at: number;
};

let enabled = true;
let processDelayMs = 120;
let shopifyDelayMs = 80;
let shouldTimeout = false;
let shouldThrow = false;
let calls: MockOrchestratorCall[] = [];

export function resetMockOrchestrator(): void {
  enabled = true;
  processDelayMs = 120;
  shopifyDelayMs = 80;
  shouldTimeout = false;
  shouldThrow = false;
  calls = [];
}

export function setMockOrchestratorDelay(ms: number): void {
  processDelayMs = ms;
}

export function setMockOrchestratorShopifyDelay(ms: number): void {
  shopifyDelayMs = ms;
}

export function setMockOrchestratorTimeout(timeout: boolean): void {
  shouldTimeout = timeout;
}

export function setMockOrchestratorThrow(should: boolean): void {
  shouldThrow = should;
}

export function setMockOrchestratorEnabled(value: boolean): void {
  enabled = value;
}

export function getMockOrchestratorCalls(): MockOrchestratorCall[] {
  return [...calls];
}

export function createMockOrchestratorService() {
  return {
    isEnabled: () => enabled,
    async processUtterance(
      callSessionId: string,
      utterance: string,
      _history: unknown[] = [],
    ): Promise<VoiceTurnOutput> {
      calls.push({ callSessionId, utterance, at: Date.now() });

      if (shouldThrow) {
        throw new Error('orchestrator_failed');
      }

      if (shouldTimeout) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        await new Promise((r) => setTimeout(r, processDelayMs));
      }

      const shopifyResult: AgentTaskResult = {
        agent: 'shopify_search',
        ok: !shouldTimeout,
        data: shouldTimeout
          ? undefined
          : { products: [{ title: 'Dune', price: '$18.99', inStock: true }] },
        latencyMs: shouldTimeout ? 2500 : shopifyDelayMs,
        error: shouldTimeout ? 'agent_timeout' : undefined,
      };

      const agentResults: AgentTaskResult[] = [
        { agent: 'memory', ok: true, latencyMs: 12 },
        shopifyResult,
      ];

      const isProduct = /book|dune|isbn|have/i.test(utterance);

      return {
        reply: isProduct
          ? 'I found "Dune" for $18.99. It\'s in stock. Would you like a checkout link?'
          : 'Happy to help! What book are you looking for?',
        immediateFiller: isProduct ? 'Let me check that for you…' : undefined,
        intent: isProduct ? 'product_search' : 'casual',
        needsDeferredPoll: isProduct,
        agentResults,
        modelUsed: 'gpt-4o-mini-template',
        totalLatencyMs: processDelayMs + shopifyDelayMs,
        turnProof: { architecture: 'mock_orchestrator' },
      };
    },
  };
}
