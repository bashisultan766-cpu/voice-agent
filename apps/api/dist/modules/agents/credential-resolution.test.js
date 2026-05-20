"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const agents_service_1 = require("./agents.service");
(0, node_test_1.default)('uses agent credential before workspace and env', () => {
    const resolved = (0, agents_service_1.resolveCredentialPriority)('agent-key', 'workspace-key', 'env-key');
    strict_1.default.equal(resolved.source, 'agent');
    strict_1.default.equal(resolved.value, 'agent-key');
});
(0, node_test_1.default)('uses workspace credential when agent value missing', () => {
    const resolved = (0, agents_service_1.resolveCredentialPriority)('', 'workspace-key', 'env-key');
    strict_1.default.equal(resolved.source, 'workspace');
    strict_1.default.equal(resolved.value, 'workspace-key');
});
(0, node_test_1.default)('uses env credential when agent/workspace missing', () => {
    const resolved = (0, agents_service_1.resolveCredentialPriority)(undefined, '', 'env-key');
    strict_1.default.equal(resolved.source, 'env');
    strict_1.default.equal(resolved.value, 'env-key');
});
(0, node_test_1.default)('returns missing source when no credential found', () => {
    const resolved = (0, agents_service_1.resolveCredentialPriority)('', undefined, '  ');
    strict_1.default.equal(resolved.source, 'missing');
    strict_1.default.equal(resolved.value, undefined);
});
//# sourceMappingURL=credential-resolution.test.js.map