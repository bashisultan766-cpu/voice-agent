import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionContextService } from './session-context.service';

function buildPrismaMock(sessionFactory: () => Record<string, unknown>) {
  return {
    callSession: {
      findUnique: async () => sessionFactory(),
    },
    tenantIntegration: {
      findUnique: async () => null,
    },
  } as const;
}

function buildEncryptionMock() {
  return {
    isAvailable: () => false,
    decryptFromStorage: () => null,
  } as const;
}

test('loads latest prompt + config version on new session load', async () => {
  let version = 1;
  let prompt = 'OLD_PROMPT';
  const service = new SessionContextService(
    buildPrismaMock(() => ({
      id: 'sess_1',
      tenantId: 'tenant_1',
      storeId: null,
      agentId: 'agent_1',
      phoneNumberId: null,
      fromNumber: '+10000000000',
      toNumber: '+12223334444',
      metadata: {},
      agent: {
        id: 'agent_1',
        name: 'Ava',
        voice: null,
        voiceProvider: 'elevenlabs',
        voiceId: 'voice_new',
        voiceStyle: 'professional',
        language: 'en',
        baseSystemPrompt: prompt,
        agentGoal: null,
        agentRole: null,
        toneOfVoice: null,
        allowedActions: null,
        restrictedActions: null,
        escalationInstructions: null,
        returnRefundBehavior: null,
        orderStatusHandling: null,
        outOfStockHandling: null,
        transferToHumanEnabled: true,
        escalationPhone: null,
        escalationEmail: null,
        greetingMessage: null,
        fallbackMessage: null,
        escalationMessage: null,
        model: 'gpt-4o-mini',
        temperature: null,
        enabledTools: null,
        toolPermissions: null,
        maxToolCallsPerTurn: 2,
        handoffEnabled: true,
        knowledgeBaseSource: null,
        knowledgeSyncEnabled: true,
        callRoutingMode: null,
        incomingCallHandling: null,
        secretsEnc: null,
        shopifyStoreUrl: null,
        shopifyConnectionStatus: 'UNKNOWN',
        timezone: 'UTC',
        updatedAt: new Date('2026-05-28T12:00:00.000Z'),
        voiceProfile: null,
        agentConfig: {
          businessName: null,
          supportEmail: null,
          supportPhone: null,
          shippingPolicy: null,
          returnPolicy: null,
          exchangePolicy: null,
          deliveryNotes: null,
          escalationRules: null,
          forbiddenBehaviors: null,
          checkoutMode: 'STOREFRONT_CART',
          askEmailBeforePaymentLink: true,
          fallbackHumanContact: null,
          customSystemPrompt: prompt,
          humanHandoffRules: null,
          useWorkspaceShopify: false,
          useWorkspaceOpenai: false,
          useWorkspaceElevenlabs: false,
          useWorkspaceEmail: false,
          metadata: {
            configVersion: version,
            promptUpdatedAt: '2026-05-28T12:00:00.000Z',
          },
          updatedAt: new Date('2026-05-28T12:00:00.000Z'),
        },
      },
      store: null,
    })) as never,
    buildEncryptionMock() as never,
  );

  const first = await service.load('sess_1');
  assert.equal(first?.agent.baseSystemPrompt, 'OLD_PROMPT');
  assert.equal(first?.configVersion, 1);

  version = 2;
  prompt = 'NEW_PROMPT';
  const second = await service.load('sess_1');
  assert.equal(second?.agent.baseSystemPrompt, 'NEW_PROMPT');
  assert.equal(second?.agent.config?.customSystemPrompt, 'NEW_PROMPT');
  assert.equal(second?.configVersion, 2);
});

test('repeated load within TTL uses session context cache', async () => {
  let findUniqueCalls = 0;
  const prisma = {
    callSession: {
      findUnique: async (args: { select?: unknown }) => {
        findUniqueCalls += 1;
        const isStampRead = Boolean(args?.select);
        return {
          id: 'sess_cache',
          tenantId: 'tenant_1',
          storeId: null,
          agentId: 'agent_1',
          phoneNumberId: null,
          fromNumber: '+10000000000',
          toNumber: '+12223334444',
          metadata: {},
          agent: {
            id: 'agent_1',
            name: 'Ava',
            voice: null,
            voiceProvider: 'elevenlabs',
            voiceId: 'voice_new',
            voiceStyle: 'professional',
            language: 'en',
            baseSystemPrompt: 'PROMPT',
            agentGoal: null,
            agentRole: null,
            toneOfVoice: null,
            allowedActions: null,
            restrictedActions: null,
            escalationInstructions: null,
            returnRefundBehavior: null,
            orderStatusHandling: null,
            outOfStockHandling: null,
            transferToHumanEnabled: true,
            escalationPhone: null,
            escalationEmail: null,
            greetingMessage: null,
            fallbackMessage: null,
            escalationMessage: null,
            model: 'gpt-4o-mini',
            temperature: null,
            enabledTools: null,
            toolPermissions: null,
            maxToolCallsPerTurn: 2,
            handoffEnabled: true,
            knowledgeBaseSource: null,
            knowledgeSyncEnabled: true,
            callRoutingMode: null,
            incomingCallHandling: null,
            secretsEnc: null,
            shopifyStoreUrl: null,
            shopifyConnectionStatus: 'UNKNOWN',
            timezone: 'UTC',
            updatedAt: new Date('2026-05-28T12:00:00.000Z'),
            voiceProfile: null,
            agentConfig: isStampRead
              ? {
                  updatedAt: new Date('2026-05-28T12:00:00.000Z'),
                  metadata: { configVersion: 1 },
                }
              : {
                  businessName: null,
                  supportEmail: null,
                  supportPhone: null,
                  shippingPolicy: null,
                  returnPolicy: null,
                  exchangePolicy: null,
                  deliveryNotes: null,
                  escalationRules: null,
                  forbiddenBehaviors: null,
                  checkoutMode: 'STOREFRONT_CART',
                  askEmailBeforePaymentLink: true,
                  fallbackHumanContact: null,
                  customSystemPrompt: 'PROMPT',
                  humanHandoffRules: null,
                  useWorkspaceShopify: false,
                  useWorkspaceOpenai: false,
                  useWorkspaceElevenlabs: false,
                  useWorkspaceEmail: false,
                  metadata: { configVersion: 1 },
                  updatedAt: new Date('2026-05-28T12:00:00.000Z'),
                },
          },
          store: null,
        };
      },
    },
    tenantIntegration: {
      findUnique: async () => null,
    },
  } as const;

  const service = new SessionContextService(prisma as never, buildEncryptionMock() as never);
  const first = await service.load('sess_cache');
  const second = await service.load('sess_cache');
  assert.equal(first?.agent.baseSystemPrompt, 'PROMPT');
  assert.equal(second?.agent.baseSystemPrompt, 'PROMPT');
  assert.ok(findUniqueCalls >= 2, 'second load should use lightweight stamp read, not full reload');
});

