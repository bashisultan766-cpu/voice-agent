"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const throttler_1 = require("@nestjs/throttler");
const prisma_module_1 = require("./database/prisma.module");
const common_module_1 = require("./common/common.module");
const auth_module_1 = require("./modules/auth/auth.module");
const jwt_auth_guard_1 = require("./modules/auth/jwt-auth.guard");
const health_module_1 = require("./modules/health/health.module");
const tenants_module_1 = require("./modules/tenants/tenants.module");
const users_module_1 = require("./modules/users/users.module");
const stores_module_1 = require("./modules/stores/stores.module");
const agents_module_1 = require("./modules/agents/agents.module");
const phone_numbers_module_1 = require("./modules/phone-numbers/phone-numbers.module");
const prompts_module_1 = require("./modules/prompts/prompts.module");
const knowledge_module_1 = require("./modules/knowledge/knowledge.module");
const calls_module_1 = require("./modules/calls/calls.module");
const transcripts_module_1 = require("./modules/transcripts/transcripts.module");
const tools_module_1 = require("./modules/tools/tools.module");
const audit_logs_module_1 = require("./modules/audit-logs/audit-logs.module");
const integrations_module_1 = require("./modules/integrations/integrations.module");
const analytics_module_1 = require("./modules/analytics/analytics.module");
const ops_module_1 = require("./modules/ops/ops.module");
const clients_module_1 = require("./modules/clients/clients.module");
const tenant_integrations_module_1 = require("./modules/tenant-integrations/tenant-integrations.module");
const env_validation_1 = require("./common/env-validation");
const roles_guard_1 = require("./modules/auth/roles.guard");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: '.env',
                validate: (config) => {
                    const parsed = (0, env_validation_1.parseEnv)();
                    if (!parsed.ok) {
                        const flat = parsed.error.flatten().fieldErrors;
                        throw new Error(`Invalid environment: ${JSON.stringify(flat)}`);
                    }
                    const prod = (0, env_validation_1.validateProductionEnv)();
                    if (config.NODE_ENV === 'production' && !prod.ok) {
                        throw new Error(`Production environment invalid: ${prod.missing.join(', ')}`);
                    }
                    return config;
                },
            }),
            throttler_1.ThrottlerModule.forRoot([
                {
                    ttl: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 60_000,
                    limit: Number(process.env.API_RATE_LIMIT_MAX_REQUESTS) || 120,
                },
            ]),
            prisma_module_1.PrismaModule,
            common_module_1.CommonModule,
            auth_module_1.AuthModule,
            health_module_1.HealthModule,
            tenants_module_1.TenantsModule,
            users_module_1.UsersModule,
            stores_module_1.StoresModule,
            agents_module_1.AgentsModule,
            phone_numbers_module_1.PhoneNumbersModule,
            prompts_module_1.PromptsModule,
            knowledge_module_1.KnowledgeModule,
            calls_module_1.CallsModule,
            transcripts_module_1.TranscriptsModule,
            tools_module_1.ToolsModule,
            audit_logs_module_1.AuditLogsModule,
            integrations_module_1.IntegrationsModule,
            analytics_module_1.AnalyticsModule,
            ops_module_1.OpsModule,
            clients_module_1.ClientsModule,
            tenant_integrations_module_1.TenantIntegrationsModule,
        ],
        providers: [
            jwt_auth_guard_1.JwtAuthGuard,
            { provide: core_1.APP_GUARD, useClass: throttler_1.ThrottlerGuard },
            { provide: core_1.APP_GUARD, useClass: jwt_auth_guard_1.JwtAuthGuard },
            { provide: core_1.APP_GUARD, useClass: roles_guard_1.RolesGuard },
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map