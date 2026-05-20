import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AgentsService } from '../modules/agents/agents.service';
import { PrismaService } from '../database/prisma.service';
import { SessionContextService } from '../modules/calls/runtime/session-context.service';

async function main() {
  const tenantId = process.env.VERIFY_TENANT_ID?.trim();
  if (!tenantId) {
    throw new Error('VERIFY_TENANT_ID is required.');
  }

  const stamp = Date.now().toString().slice(-6);
  const agentName = `Frontend Verify ${stamp}`;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const agents = app.get(AgentsService);
    const prisma = app.get(PrismaService);
    const sessionCtx = app.get(SessionContextService);

    const created = await agents.create(
      tenantId,
      {
        agentName,
        storeName: 'Integration Test Store',
        agentStatus: 'draft',
        language: 'en',
        timezone: 'UTC',
        checkoutMode: 'cart',
      } as never,
    );

    const dbAgent = await prisma.agent.findFirst({
      where: { id: created.id, tenantId, deletedAt: null },
      include: { agentConfig: true },
    });

    const call = await prisma.callSession.create({
      data: {
        tenantId,
        agentId: created.id,
        storeId: created.storeId ?? null,
        status: 'INITIATED',
        direction: 'inbound',
        startedAt: new Date(),
      },
    });

    const loaded = await sessionCtx.load(call.id);
    console.log(
      JSON.stringify(
        {
          createdAgentId: created.id,
          dbSaved: Boolean(dbAgent),
          hasAgentConfig: Boolean(dbAgent?.agentConfig),
          sessionContextLoaded: Boolean(loaded),
          loadedCheckoutMode: loaded?.agent?.config?.checkoutMode ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
