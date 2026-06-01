import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentEmailSubjectService } from './payment-email-subject.service';
import type { ResolvedAgentEmailConfig } from './agent-email-config.service';
export type PaymentEmailDeliveryProof = {
    success: boolean;
    smtpAccepted: boolean;
    providerSuccess: boolean;
    deliveryQueued: boolean;
    providerMessageId: string | null;
    emailEventId: string;
    deduplicated?: boolean;
};
type SendPaymentEmailResult = PaymentEmailDeliveryProof;
export declare class ResendEmailService {
    private readonly config;
    private readonly prisma;
    private readonly paymentEmailSubject;
    private readonly logger;
    constructor(config: ConfigService, prisma: PrismaService, paymentEmailSubject: PaymentEmailSubjectService);
    private apiKey;
    sendPaymentEmail(input: {
        tenantId: string;
        agentId: string;
        callSessionId?: string;
        checkoutLinkId: string;
        idempotencyKey?: string;
        to: string;
        businessName: string;
        supportEmail?: string | null;
        supportPhone?: string | null;
        checkoutUrl: string;
        items: Array<{
            title: string;
            quantity: number;
            price?: string | null;
        }>;
        emailConfig?: ResolvedAgentEmailConfig | null;
    }): Promise<SendPaymentEmailResult>;
}
export {};
