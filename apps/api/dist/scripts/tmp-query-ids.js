"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
async function main() {
    const prisma = new client_1.PrismaClient();
    try {
        const firstAgent = await prisma.agent.findFirst({
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, tenantId: true },
        });
        if (!firstAgent) {
            console.log('NO_AGENT');
            return;
        }
        console.log(JSON.stringify({ tenantId: firstAgent.tenantId, agentId: firstAgent.id }));
    }
    finally {
        await prisma.$disconnect();
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=tmp-query-ids.js.map