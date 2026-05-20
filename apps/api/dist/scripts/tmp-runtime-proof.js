"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
async function main() {
    const prisma = new client_1.PrismaClient();
    const callSessionId = process.env.DEV_CALL_SESSION_ID;
    if (!callSessionId)
        throw new Error('DEV_CALL_SESSION_ID is required');
    const callSession = await prisma.callSession.findUnique({
        where: { id: callSessionId },
        select: {
            id: true,
            tenantId: true,
            agentId: true,
            fromNumber: true,
            toNumber: true,
            startedAt: true,
            endedAt: true,
            createdAt: true,
        },
    });
    const transcriptCount = await prisma.callTranscript.count({ where: { callSessionId } });
    const checkoutLinks = await prisma.checkoutLink.findMany({
        where: { callSessionId },
        select: { id: true, status: true, checkoutUrl: true, customerEmail: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
    });
    const emailEvents = await prisma.emailEvent.findMany({
        where: { callSessionId },
        select: {
            id: true,
            status: true,
            recipientEmail: true,
            checkoutLinkId: true,
            idempotencyKey: true,
            createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 3,
    });
    const leads = await prisma.leadCapture.findMany({
        where: { callSessionId },
        select: { id: true, customerEmail: true, customerPhone: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
    });
    const toolExecutions = await prisma.toolExecution.findMany({
        where: { callSessionId },
        select: {
            id: true,
            toolName: true,
            status: true,
            latencyMs: true,
            outputJson: true,
            createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
    });
    console.log(JSON.stringify({
        callSession,
        transcriptCount,
        checkoutLinks,
        emailEvents,
        leads,
        toolExecutions,
    }, null, 2));
    await prisma.$disconnect();
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=tmp-runtime-proof.js.map