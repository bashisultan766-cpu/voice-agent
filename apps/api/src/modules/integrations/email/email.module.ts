import { Module } from '@nestjs/common';
import { ResendEmailService } from './resend-email.service';
import { AgentEmailConfigService } from './agent-email-config.service';

@Module({
  providers: [ResendEmailService, AgentEmailConfigService],
  exports: [ResendEmailService, AgentEmailConfigService],
})
export class EmailModule {}
