import { Module } from '@nestjs/common';
import { TenantIntegrationsController } from './tenant-integrations.controller';
import { TenantIntegrationsService } from './tenant-integrations.service';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [AgentsModule],
  controllers: [TenantIntegrationsController],
  providers: [TenantIntegrationsService],
  exports: [TenantIntegrationsService],
})
export class TenantIntegrationsModule {}
