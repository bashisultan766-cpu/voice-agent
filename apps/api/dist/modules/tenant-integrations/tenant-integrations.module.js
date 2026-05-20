"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantIntegrationsModule = void 0;
const common_1 = require("@nestjs/common");
const tenant_integrations_controller_1 = require("./tenant-integrations.controller");
const tenant_integrations_service_1 = require("./tenant-integrations.service");
const agents_module_1 = require("../agents/agents.module");
let TenantIntegrationsModule = class TenantIntegrationsModule {
};
exports.TenantIntegrationsModule = TenantIntegrationsModule;
exports.TenantIntegrationsModule = TenantIntegrationsModule = __decorate([
    (0, common_1.Module)({
        imports: [agents_module_1.AgentsModule],
        controllers: [tenant_integrations_controller_1.TenantIntegrationsController],
        providers: [tenant_integrations_service_1.TenantIntegrationsService],
        exports: [tenant_integrations_service_1.TenantIntegrationsService],
    })
], TenantIntegrationsModule);
//# sourceMappingURL=tenant-integrations.module.js.map