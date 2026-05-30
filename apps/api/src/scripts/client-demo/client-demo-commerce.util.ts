import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CallsService } from '../../modules/calls/calls.service';
import { SessionContextService } from '../../modules/calls/runtime/session-context.service';
import { ToolOrchestratorService } from '../../modules/calls/runtime/tool-orchestrator.service';

export type CommerceToolEnvelope = {
  callSessionId: string;
  toolName: string;
  result: {
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
};

export function readToolData(result: CommerceToolEnvelope['result']): Record<string, unknown> {
  return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? (result.data as Record<string, unknown>)
    : {};
}

export async function executeCommerceTool(
  app: INestApplicationContext,
  tenantId: string,
  agentId: string,
  input: {
    toolName: string;
    args?: Record<string, unknown>;
    callSessionId?: string;
  },
): Promise<CommerceToolEnvelope> {
  const prisma = app.get(PrismaService);
  const calls = app.get(CallsService);
  const sessionContext = app.get(SessionContextService);
  const orchestrator = app.get(ToolOrchestratorService);

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, tenantId, deletedAt: null },
    select: { id: true, storeId: true, twilioPhoneNumber: true },
  });
  if (!agent) throw new Error('Agent not found for client-demo commerce tool.');

  let callSessionId = input.callSessionId?.trim() || '';
  if (!callSessionId) {
    const now = Date.now();
    const session = await calls.createSession({
      tenantId,
      agentId: agent.id,
      storeId: agent.storeId ?? null,
      twilioCallSid: `client-demo-${now}`,
      fromNumber: '+15550000001',
      toNumber: agent.twilioPhoneNumber ?? '+15550000002',
      direction: 'inbound',
    });
    callSessionId = session.id;
  }

  const ctx = await sessionContext.load(callSessionId);
  if (!ctx || ctx.tenantId !== tenantId || ctx.agentId !== agent.id) {
    throw new Error('callSessionId does not match tenant/agent context.');
  }

  const result = await orchestrator.execute(
    ctx,
    input.toolName,
    input.args ?? {},
    callSessionId,
    `client-demo-${Date.now()}`,
  );

  return { callSessionId, toolName: input.toolName, result };
}
