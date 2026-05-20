"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const common_1 = require("@nestjs/common");
const ownership_linkage_1 = require("./ownership-linkage");
(0, node_test_1.default)('requires store in production mode', () => {
    strict_1.default.throws(() => (0, ownership_linkage_1.assertProductionOwnershipRequired)({ nodeEnv: 'production', clientId: '', storeId: '' }), common_1.BadRequestException);
    strict_1.default.doesNotThrow(() => (0, ownership_linkage_1.assertProductionOwnershipRequired)({ nodeEnv: 'production', clientId: '', storeId: 'store_1' }));
});
(0, node_test_1.default)('allows missing client/store outside production', () => {
    strict_1.default.doesNotThrow(() => (0, ownership_linkage_1.assertProductionOwnershipRequired)({ nodeEnv: 'development', clientId: '', storeId: '' }));
});
(0, node_test_1.default)('rejects cross-tenant ownership linkage', () => {
    strict_1.default.throws(() => (0, ownership_linkage_1.assertTenantOwnership)({ tenantId: 'tenant_a', clientTenantId: 'tenant_b' }), common_1.BadRequestException);
    strict_1.default.throws(() => (0, ownership_linkage_1.assertTenantOwnership)({ tenantId: 'tenant_a', storeTenantId: 'tenant_c' }), common_1.BadRequestException);
});
//# sourceMappingURL=ownership-linkage.test.js.map