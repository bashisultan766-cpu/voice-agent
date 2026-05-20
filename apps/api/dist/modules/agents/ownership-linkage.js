"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertProductionOwnershipRequired = assertProductionOwnershipRequired;
exports.assertTenantOwnership = assertTenantOwnership;
const common_1 = require("@nestjs/common");
function assertProductionOwnershipRequired(params) {
    if (params.nodeEnv !== 'production')
        return;
    if (!params.storeId?.trim()) {
        throw new common_1.BadRequestException('storeId is required in production. Add a store under Settings → Integrations (Shopify) or Stores, then select it when creating the agent.');
    }
}
function assertTenantOwnership(params) {
    if (params.clientTenantId && params.clientTenantId !== params.tenantId) {
        throw new common_1.BadRequestException('Client does not belong to this tenant.');
    }
    if (params.storeTenantId && params.storeTenantId !== params.tenantId) {
        throw new common_1.BadRequestException('Store does not belong to this tenant.');
    }
}
//# sourceMappingURL=ownership-linkage.js.map