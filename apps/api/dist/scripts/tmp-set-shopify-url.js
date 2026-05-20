"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
async function main() {
    const prisma = new client_1.PrismaClient();
    const tenantId = process.env.DEV_TENANT_ID;
    const agentId = process.env.DEV_AGENT_ID;
    if (!tenantId || !agentId) {
        throw new Error('DEV_TENANT_ID and DEV_AGENT_ID are required');
    }
    const updated = await prisma.agent.update({
        where: { id: agentId },
        data: {
            tenantId,
            shopifyStoreUrl: 'https://demo-shop.myshopify.com',
        },
        select: { id: true, tenantId: true, shopifyStoreUrl: true, storeUrl: true },
    });
    console.log(JSON.stringify(updated));
    await prisma.$disconnect();
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=tmp-set-shopify-url.js.map