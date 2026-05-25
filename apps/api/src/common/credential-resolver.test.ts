import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegacyWebVoicePathAllowed,
} from '@bookstore-voice-agents/types';
import {
  buildCredentialSourcesSummary,
  resolveCredentialPriority,
  resolveEmailKeyConfig,
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

test('env Shopify never overrides agent Shopify', () => {
  const resolved = resolveShopifyConfig({
    agent: {
      shopifyStoreUrl: 'https://agent.myshopify.com',
      secrets: { shopifyAdminToken: 'agent-token' },
      useWorkspaceShopify: true,
    },
    workspace: {
      shopifyStoreUrl: 'https://ws.myshopify.com',
      shopifyAdminToken: 'ws-token',
    },
    env: {
      shopifyStoreUrl: 'https://env.myshopify.com',
      shopifyAdminToken: 'env-token',
    },
  });
  assert.equal(resolved?.source, 'agent');
  assert.equal(resolved?.shopifyAdminToken, 'agent-token');
});

test('readiness summary marks workspace-only Shopify failed when useWorkspaceShopify is false', () => {
  const summary = buildCredentialSourcesSummary({
    agent: { useWorkspaceShopify: false },
    workspace: {
      shopifyStoreUrl: 'https://store-w.myshopify.com',
      shopifyAdminToken: 'token-w',
    },
  });
  assert.equal(summary.shopify.configured, false);
  assert.equal(summary.shopify.source, 'workspace');
  assert.equal(summary.shopify.useWorkspaceShopify, false);
});

test('OpenAI agent key wins over workspace and env', () => {
  const resolved = resolveCredentialPriority('agent-key', 'workspace-key', 'env-key');
  assert.equal(resolved.source, 'agent');
  assert.equal(resolved.value, 'agent-key');
});

test('agent Resend key wins even when useWorkspaceEmail is true', () => {
  const resolved = resolveEmailKeyConfig({
    agentSecrets: { resendApiKey: 'agent-resend' },
    workspace: { resendApiKey: 'workspace-resend' },
    envApiKey: 'env-resend',
    useWorkspaceEmail: true,
    allowEnvFallback: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.source, 'agent');
  assert.equal(resolved.apiKey, 'agent-resend');
});

test('workspace Resend used when useWorkspaceEmail true and no agent key', () => {
  const resolved = resolveEmailKeyConfig({
    workspace: { resendApiKey: 'workspace-resend' },
    envApiKey: 'env-resend',
    useWorkspaceEmail: true,
    allowEnvFallback: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.source, 'workspace');
});

test('readiness summary reports agent Shopify source when configured', () => {
  const summary = buildCredentialSourcesSummary({
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
  assert.equal(summary.shopify.configured, true);
  assert.equal(summary.shopify.source, 'agent');
});

test('legacy web voice path blocked in production', () => {
  assert.equal(isLegacyWebVoicePathAllowed('production'), false);
  assert.equal(isLegacyWebVoicePathAllowed('development'), true);
  assert.equal(isLegacyWebVoicePathAllowed(undefined), true);
});
