import test from 'node:test';

import assert from 'node:assert/strict';

import {

  isLegacyWebVoicePathAllowed,

} from '@bookstore-voice-agents/types';

import {

  buildCredentialSourcesSummary,

  resolveCredentialPriority,

  resolveEmailKeyConfig,

  resolveOpenAiConfig,
  resolveTwilioConfig,

  resolveShopifyConfig,

} from './credential-resolver.util';



test('Agent A Shopify wins over workspace Shopify W', () => {

  const resolved = resolveShopifyConfig({

    agent: {

      shopifyStoreUrl: 'https://store-a.myshopify.com',

      secrets: { shopifyAdminToken: 'token-a' },

      useWorkspaceShopify: false,

    },

    workspace: {

      shopifyStoreUrl: 'https://store-w.myshopify.com',

      shopifyAdminToken: 'token-w',

    },

  });

  assert.ok(resolved);

  assert.equal(resolved.source, 'agent');

  assert.equal(resolved.shopifyAdminToken, 'token-a');

  assert.match(resolved.shopifyStoreUrl, /store-a/);

});



test('Agent B without Shopify and useWorkspaceShopify=false does not resolve', () => {

  const resolved = resolveShopifyConfig({

    agent: { useWorkspaceShopify: false },

    workspace: {

      shopifyStoreUrl: 'https://store-w.myshopify.com',

      shopifyAdminToken: 'token-w',

    },

    env: {

      shopifyStoreUrl: 'https://env.myshopify.com',

      shopifyAdminToken: 'env-token',

    },

  });

  assert.equal(resolved, null);

});



test('Agent C without Shopify and useWorkspaceShopify=true uses workspace', () => {

  const resolved = resolveShopifyConfig({

    agent: { useWorkspaceShopify: true },

    workspace: {

      shopifyStoreUrl: 'https://store-w.myshopify.com',

      shopifyAdminToken: 'token-w',

    },

  });

  assert.ok(resolved);

  assert.equal(resolved.source, 'workspace');

  assert.equal(resolved.shopifyAdminToken, 'token-w');

});



test('OpenAI falls back to workspace when agent key missing', () => {

  const prev = process.env.NODE_ENV;

  process.env.NODE_ENV = 'production';

  const resolved = resolveOpenAiConfig({

    workspace: { openaiApiKey: 'workspace-key' },

    useWorkspaceOpenai: false,

    envApiKey: 'env-key',

  });

  process.env.NODE_ENV = prev;

  assert.ok(resolved);
  assert.equal(resolved.source, 'workspace');
  assert.equal(resolved.apiKey, 'workspace-key');

});



test('OpenAI with useWorkspaceOpenai uses workspace in production', () => {

  const prev = process.env.NODE_ENV;

  process.env.NODE_ENV = 'production';

  const resolved = resolveOpenAiConfig({

    workspace: { openaiApiKey: 'workspace-key' },

    useWorkspaceOpenai: true,

    envApiKey: 'env-key',

  });

  process.env.NODE_ENV = prev;

  assert.ok(resolved);

  assert.equal(resolved.source, 'workspace');

});



test('Twilio falls back to workspace credentials when agent credentials are missing', () => {

  const resolved = resolveTwilioConfig({

    workspace: {

      twilioAccountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',

      twilioAuthToken: 'workspace-token',

      twilioPhoneNumber: '+12512554549',

    },

    useWorkspaceTwilio: false,

  });

  assert.ok(resolved);

  assert.equal(resolved.authSource, 'workspace');

  assert.equal(resolved.sidSource, 'workspace');

  assert.equal(resolved.phoneNumber, '+12512554549');

});



test('Twilio agent credentials override workspace credentials', () => {

  const resolved = resolveTwilioConfig({

    agentSecrets: {

      twilioAccountSid: 'ACbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',

      twilioAuthToken: 'agent-token',

    },

    workspace: {

      twilioAccountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',

      twilioAuthToken: 'workspace-token',

    },

    useWorkspaceTwilio: true,

  });

  assert.ok(resolved);

  assert.equal(resolved.authSource, 'agent');

  assert.equal(resolved.sidSource, 'agent');

});



test('Twilio returns missing when no agent/workspace credentials exist', () => {

  const resolved = resolveTwilioConfig({

    workspace: {},

    useWorkspaceTwilio: false,

  });

  assert.equal(resolved, null);

});



test('OpenAI agent key overrides workspace key', () => {

  const resolved = resolveOpenAiConfig({

    agentSecrets: { openaiApiKey: 'agent-openai-key' },

    workspace: { openaiApiKey: 'workspace-openai-key' },

    useWorkspaceOpenai: false,

  });

  assert.ok(resolved);

  assert.equal(resolved.source, 'agent');

  assert.equal(resolved.apiKey, 'agent-openai-key');

});



test('OpenAI returns missing when no agent/workspace keys exist', () => {

  const resolved = resolveOpenAiConfig({

    workspace: {},

    useWorkspaceOpenai: false,

  });

  assert.equal(resolved, null);

});



test('agent Resend key wins when useWorkspaceEmail is true', () => {

  const resolved = resolveEmailKeyConfig({

    agentSecrets: { resendApiKey: 'agent-resend' },

    workspace: { resendApiKey: 'workspace-resend' },

    envApiKey: 'env-resend',

    useWorkspaceEmail: true,

  });

  assert.ok(resolved);

  assert.equal(resolved.source, 'agent');

});



test('workspace Resend not used when useWorkspaceEmail is false', () => {

  const resolved = resolveEmailKeyConfig({

    workspace: { resendApiKey: 'workspace-resend' },

    envApiKey: 'env-resend',

    useWorkspaceEmail: false,

  });

  assert.equal(resolved, null);

});



test('readiness summary marks workspace-only Shopify blocked when useWorkspaceShopify is false', () => {

  const summary = buildCredentialSourcesSummary({

    agent: { useWorkspaceShopify: false },

    workspace: {

      shopifyStoreUrl: 'https://store-w.myshopify.com',

      shopifyAdminToken: 'token-w',

    },

  });

  assert.equal(summary.shopify.configured, false);

  assert.equal(summary.shopify.source, 'workspace');

});



test('readiness summary marks workspace Twilio/OpenAI sources when agent keys missing', () => {

  const summary = buildCredentialSourcesSummary({

    agent: { useWorkspaceTwilio: false, useWorkspaceOpenai: false },

    workspace: {

      twilioAccountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',

      twilioAuthToken: 'workspace-token',

      openaiApiKey: 'workspace-openai-key',

    },

  });

  assert.equal(summary.twilio.authSource, 'workspace');

  assert.equal(summary.openai.source, 'workspace');

});



test('legacy web voice path blocked in production', () => {

  assert.equal(isLegacyWebVoicePathAllowed('production'), false);

  assert.equal(isLegacyWebVoicePathAllowed('development'), true);

});



test('OpenAI agent key wins over workspace', () => {

  const resolved = resolveCredentialPriority('agent-key', 'workspace-key', 'env-key');

  assert.equal(resolved.source, 'agent');

});


