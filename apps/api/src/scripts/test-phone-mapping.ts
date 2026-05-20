import 'reflect-metadata';
import { normalizePhoneNumber } from '@bookstore-voice-agents/types';
import { PrismaService } from '../database/prisma.service';
import { AgentResolutionService } from '../modules/integrations/twilio/agent-resolution.service';
import { assertTenantAgentContext, optionalEnv, requireEnv, withDevAppContext } from './dev-script-context';

function last4(value: string): string {
  const d = value.replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : d;
}

async function run() {
  const tenantId = requireEnv('DEV_TENANT_ID');
  const agentId = requireEnv('DEV_AGENT_ID');
  const testTo = optionalEnv('DEV_TWILIO_TEST_TO');

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    const resolution = app.get(AgentResolutionService);

    await assertTenantAgentContext(prisma, tenantId, agentId);

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId, deletedAt: null },
      select: { id: true, name: true, twilioPhoneNumber: true, status: true },
    });
    if (!agent) {
      // eslint-disable-next-line no-console
      console.error('FAIL: agent not found');
      process.exitCode = 1;
      return;
    }

    const raw = agent.twilioPhoneNumber?.trim() || '';
    const normalized = raw ? normalizePhoneNumber(raw) : '';
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        agentId: agent.id,
        agentName: agent.name,
        agentStatus: agent.status,
        twilioPhoneRawLast4: raw ? last4(raw) : null,
        normalizedLast4: normalized ? last4(normalized) : null,
      }),
    );

    if (!normalized) {
      // eslint-disable-next-line no-console
      console.error('FAIL: agent has no twilioPhoneNumber; set it on the agent and save.');
      process.exitCode = 1;
      return;
    }

    const mapping = await prisma.phoneNumberMapping.findFirst({
      where: { tenantId, agentId, phoneNumber: normalized },
      select: { id: true, phoneNumber: true },
    });

    let ok = true;
    if (mapping) {
      // eslint-disable-next-line no-console
      console.log(
        `PASS: PhoneNumberMapping exists (id=${mapping.id}, normalized last4=${last4(mapping.phoneNumber)}).`,
      );
    } else {
      ok = false;
      // eslint-disable-next-line no-console
      console.error(
        'FAIL: No PhoneNumberMapping for this tenant+agent+normalized phone. Open the agent in the dashboard, set Voice phone number, and save.',
      );
    }

    const to = testTo?.trim() || normalized;
    const toNorm = normalizePhoneNumber(to);
    // eslint-disable-next-line no-console
    console.log(`Simulating inbound To=${toNorm} (last4=${last4(toNorm)})`);
    const resolved = await resolution.resolveByPhoneNumber(toNorm);
    if (resolved?.agentId === agentId && resolved.tenantId === tenantId) {
      // eslint-disable-next-line no-console
      console.log(`PASS: Inbound lookup resolved to this agent (${resolved.agentId}).`);
    } else if (resolved) {
      ok = false;
      // eslint-disable-next-line no-console
      console.error(
        `FAIL: Inbound lookup resolved to a different agent (tenantId=${resolved.tenantId} agentId=${resolved.agentId}).`,
      );
    } else {
      ok = false;
      // eslint-disable-next-line no-console
      console.error(
        'FAIL: Inbound lookup returned null — Twilio would play "line is not configured".',
      );
    }

    // eslint-disable-next-line no-console
    console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
    if (!ok) process.exitCode = 1;
  });
}

void run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exitCode = 1;
});
