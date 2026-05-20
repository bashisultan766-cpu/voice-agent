import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredentialPriority } from './agents.service';

test('uses agent credential before workspace and env', () => {
  const resolved = resolveCredentialPriority('agent-key', 'workspace-key', 'env-key');
  assert.equal(resolved.source, 'agent');
  assert.equal(resolved.value, 'agent-key');
});

test('uses workspace credential when agent value missing', () => {
  const resolved = resolveCredentialPriority('', 'workspace-key', 'env-key');
  assert.equal(resolved.source, 'workspace');
  assert.equal(resolved.value, 'workspace-key');
});

test('uses env credential when agent/workspace missing', () => {
  const resolved = resolveCredentialPriority(undefined, '', 'env-key');
  assert.equal(resolved.source, 'env');
  assert.equal(resolved.value, 'env-key');
});

test('returns missing source when no credential found', () => {
  const resolved = resolveCredentialPriority('', undefined, '  ');
  assert.equal(resolved.source, 'missing');
  assert.equal(resolved.value, undefined);
});
