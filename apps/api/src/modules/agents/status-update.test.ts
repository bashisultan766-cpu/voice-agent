import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStatus } from '@prisma/client';
import { statusDtoToPrisma } from './agents.service';
import { AgentStatusDto } from './dto/create-agent.dto';

test('statusDtoToPrisma maps PAUSED -> ACTIVE update intent correctly', () => {
  const savedStatus = statusDtoToPrisma(AgentStatusDto.ACTIVE);
  assert.equal(savedStatus, AgentStatus.ACTIVE);
});
