import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStatus } from '@prisma/client';
import { isExplicitSecretClear, statusDtoToPrisma } from './agents.service';
import { AgentStatusDto } from './dto/create-agent.dto';

test('statusDtoToPrisma maps PAUSED -> ACTIVE update intent correctly', () => {
  const savedStatus = statusDtoToPrisma(AgentStatusDto.ACTIVE);
  assert.equal(savedStatus, AgentStatus.ACTIVE);
});

test('empty secret inputs are not treated as explicit clear', () => {
  assert.equal(isExplicitSecretClear(undefined), false);
  assert.equal(isExplicitSecretClear(false), false);
  assert.equal(isExplicitSecretClear(''), false);
});

test('only clear flags explicitly set to true clear secrets', () => {
  assert.equal(isExplicitSecretClear(true), true);
});
