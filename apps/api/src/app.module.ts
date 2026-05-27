import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaModule } from './database/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { StoresModule } from './modules/stores/stores.module';
import { AgentsModule } from './modules/agents/agents.module';
import { PhoneNumbersModule } from './modules/phone-numbers/phone-numbers.module';
import { PromptsModule } from './modules/prompts/prompts.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { CallsModule } from './modules/calls/calls.module';
import { TranscriptsModule } from './modules/transcripts/transcripts.module';
import { ToolsModule } from './modules/tools/tools.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { OpsModule } from './modules/ops/ops.module';
import { ClientsModule } from './modules/clients/clients.module';
import { TenantIntegrationsModule } from './modules/tenant-integrations/tenant-integrations.module';
import { parseEnv, validateProductionEnv } from './common/env-validation';
import { RolesGuard } from './modules/auth/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: (config: Record<string, unknown>) => {
        const parsed = parseEnv();
        if (!parsed.ok) {
          const flat = parsed.error.flatten().fieldErrors;
          throw new Error(`Invalid environment: ${JSON.stringify(flat)}`);
        }
        const prod = validateProductionEnv();
        if (config.NODE_ENV === 'production' && !prod.ok) {
          throw new Error(`Production environment invalid: ${prod.missing.join(', ')}`);
        }
        return config;
      },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 60_000,
        limit: Number(process.env.API_RATE_LIMIT_MAX_REQUESTS) || 120,
      },
    ]),
    PrismaModule,
    CommonModule,
    AuthModule,
    HealthModule,
    TenantsModule,
    UsersModule,
    StoresModule,
    AgentsModule,
    PhoneNumbersModule,
    PromptsModule,
    KnowledgeModule,
    CallsModule,
    TranscriptsModule,
    ToolsModule,
    AuditLogsModule,
    IntegrationsModule,
    AnalyticsModule,
    OpsModule,
    ClientsModule,
    TenantIntegrationsModule,
  ],
  providers: [
    JwtAuthGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
