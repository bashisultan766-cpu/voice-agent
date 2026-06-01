import { Module } from '@nestjs/common';
import { ResendEmailService } from './resend-email.service';
import { AgentEmailConfigService } from './agent-email-config.service';
import { PaymentEmailSubjectService } from './payment-email-subject.service';

@Module({
  providers: [ResendEmailService, AgentEmailConfigService, PaymentEmailSubjectService],
  exports: [ResendEmailService, AgentEmailConfigService, PaymentEmailSubjectService],
})
export class EmailModule {}
