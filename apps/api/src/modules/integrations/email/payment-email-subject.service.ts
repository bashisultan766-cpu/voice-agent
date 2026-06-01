import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  resolvePaymentEmailSubject,
  type ResolvedPaymentEmailSubject,
} from './payment-email-subject.util';

export type PaymentEmailSubjectInput = {
  businessName?: string | null;
  subjectTemplate?: string | null;
};

@Injectable()
export class PaymentEmailSubjectService {
  private readonly logger = new Logger(PaymentEmailSubjectService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Resolves the outbound payment-link email subject.
   * PAYMENT_EMAIL_SUBJECT env wins over agent template and platform default.
   */
  getPaymentLinkSubject(input: PaymentEmailSubjectInput = {}): ResolvedPaymentEmailSubject {
    const envOverride =
      this.config.get<string>('PAYMENT_EMAIL_SUBJECT')?.trim() ||
      process.env.PAYMENT_EMAIL_SUBJECT?.trim() ||
      undefined;

    const resolved = resolvePaymentEmailSubject({
      businessName: input.businessName,
      subjectTemplate: input.subjectTemplate,
      envOverride,
    });

    this.logger.log(
      JSON.stringify({
        event: 'email.subject.selected',
        source: resolved.source,
        subjectLength: resolved.subject.length,
        overrideUsed: resolved.overrideUsed,
      }),
    );

    if (resolved.overrideUsed) {
      this.logger.log(
        JSON.stringify({
          event: 'email.subject.override_used',
          source: 'env',
          subjectLength: resolved.subject.length,
        }),
      );
    }

    return resolved;
  }
}
