"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const types_1 = require("@bookstore-voice-agents/types");
const prisma_service_1 = require("../database/prisma.service");
const agent_resolution_service_1 = require("../modules/integrations/twilio/agent-resolution.service");
const dev_script_context_1 = require("./dev-script-context");
function last4(value) {
    const d = value.replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : d;
}
async function run() {
    const tenantId = (0, dev_script_context_1.requireEnv)('DEV_TENANT_ID');
    const agentId = (0, dev_script_context_1.requireEnv)('DEV_AGENT_ID');
    const testTo = (0, dev_script_context_1.optionalEnv)('DEV_TWILIO_TEST_TO');
    await (0, dev_script_context_1.withDevAppContext)(async (app) => {
        const prisma = app.get(prisma_service_1.PrismaService);
        const resolution = app.get(agent_resolution_service_1.AgentResolutionService);
        await (0, dev_script_context_1.assertTenantAgentContext)(prisma, tenantId, agentId);
        const agent = await prisma.agent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { id: true, name: true, twilioPhoneNumber: true, status: true },
        });
        if (!agent) {
            console.error('FAIL: agent not found');
            process.exitCode = 1;
            return;
        }
        const raw = agent.twilioPhoneNumber?.trim() || '';
        const normalized = raw ? (0, types_1.normalizePhoneNumber)(raw) : '';
        console.log(JSON.stringify({
            agentId: agent.id,
            agentName: agent.name,
            agentStatus: agent.status,
            twilioPhoneRawLast4: raw ? last4(raw) : null,
            normalizedLast4: normalized ? last4(normalized) : null,
        }));
        if (!normalized) {
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
            console.log(`PASS: PhoneNumberMapping exists (id=${mapping.id}, normalized last4=${last4(mapping.phoneNumber)}).`);
        }
        else {
            ok = false;
            console.error('FAIL: No PhoneNumberMapping for this tenant+agent+normalized phone. Open the agent in the dashboard, set Voice phone number, and save.');
        }
        const to = testTo?.trim() || normalized;
        const toNorm = (0, types_1.normalizePhoneNumber)(to);
        console.log(`Simulating inbound To=${toNorm} (last4=${last4(toNorm)})`);
        const resolved = await resolution.resolveByPhoneNumber(toNorm);
        if (resolved?.agentId === agentId && resolved.tenantId === tenantId) {
            console.log(`PASS: Inbound lookup resolved to this agent (${resolved.agentId}).`);
        }
        else if (resolved) {
            ok = false;
            console.error(`FAIL: Inbound lookup resolved to a different agent (tenantId=${resolved.tenantId} agentId=${resolved.agentId}).`);
        }
        else {
            ok = false;
            console.error('FAIL: Inbound lookup returned null — Twilio would play "line is not configured".');
        }
        console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
        if (!ok)
            process.exitCode = 1;
    });
}
void run().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
//# sourceMappingURL=test-phone-mapping.js.map