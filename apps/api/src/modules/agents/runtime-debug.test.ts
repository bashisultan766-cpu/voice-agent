import test from 'node:test';
import assert from 'node:assert/strict';

import { NotFoundException } from '@nestjs/common';
import { AgentsService } from './agents.service';

test('GET /api/agents/:id/runtime-debug returns safe runtime config shape', async () => {
  const longPrompt = 'A'.repeat(300);
  const ctx = {
    prisma: {
      agent: {
        findFirst: async () => ({
          id: 'agent_123',
          storeName: 'Shore Shot Bookstore',
          voiceId: 'voice_abc',
          baseSystemPrompt: longPrompt,
          updatedAt: new Date('2026-05-28T10:00:00.000Z'),
          agentConfig: {
            metadata: {
              configVersion: 7,
              promptUpdatedAt: '2026-05-28T09:59:00.000Z',
            },
            updatedAt: new Date('2026-05-28T09:58:00.000Z'),
          },
          voiceProfile: {
            providerConfig: {
              personality: {
                voiceEnergy: 60,
                speakingSpeed: 50,
                politeness: 75,
                upsellAggressiveness: 35,
                humorLevel: 20,
              },
              elevenlabsApiKey: 'should-not-leak',
            },
          },
        }),
      },
    },
  };

  const result = await AgentsService.prototype.getRuntimeDebug.call(
    ctx as unknown as AgentsService,
    'tenant_123',
    'agent_123',
  );

  assert.equal(result.agentId, 'agent_123');
  assert.equal(result.configVersion, 7);
  assert.equal(result.promptUpdatedAt, '2026-05-28T09:59:00.000Z');
  assert.equal(result.voiceId, 'voice_abc');
  assert.equal(result.storeName, 'Shore Shot Bookstore');
  assert.equal(result.updatedAt, '2026-05-28T10:00:00.000Z');
  assert.deepEqual(result.voicePersonality, {
    voiceEnergy: 60,
    speakingSpeed: 50,
    politeness: 75,
    upsellAggressiveness: 35,
    humorLevel: 20,
  });
  assert.equal(result.systemPromptPreview.length, 200);
  assert.equal(result.systemPromptPreview, longPrompt.slice(0, 200));

  const asJson = JSON.stringify(result);
  assert.equal(asJson.includes('baseSystemPrompt'), false);
  assert.equal(asJson.includes('openaiApiKey'), false);
  assert.equal(asJson.includes('elevenlabsApiKey'), false);
  assert.equal(asJson.includes('twilioAuthToken'), false);
  assert.equal(asJson.includes('shopifyAdminToken'), false);
  assert.equal(asJson.includes('secretsEnc'), false);
});

test('GET /api/agents/:id/runtime-debug throws when agent not found', async () => {
  const ctx = {
    prisma: {
      agent: {
        findFirst: async () => null,
      },
    },
  };
  await assert.rejects(
    AgentsService.prototype.getRuntimeDebug.call(
      ctx as unknown as AgentsService,
      'tenant_missing',
      'agent_missing',
    ),
    (err: unknown) => err instanceof NotFoundException,
  );
});

