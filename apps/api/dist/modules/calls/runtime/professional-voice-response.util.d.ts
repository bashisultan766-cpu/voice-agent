import type { OrderState } from './order-state-machine.util';
import { type ConversationTone } from './conversation-tone.util';
export type ProfessionalProduct = {
    title: string;
    price: string | null;
};
export type ProfessionalResponseToneInput = {
    conversationTone: ConversationTone;
    lastToneLeadUsed: string | null;
};
export declare function buildProfessionalResponse(args: {
    state: OrderState;
    product?: ProfessionalProduct | null;
    email?: string | null;
    found: boolean;
    includePaymentSuggestion?: boolean;
    tone?: ProfessionalResponseToneInput;
    followUpOfferedProductKey?: string | null;
}): {
    text: string;
    templateKey: string;
    toneLeadUsed?: string | null;
    paymentSuggestionUsed?: boolean;
    followUpTriggered?: boolean;
    followUpOfferedProductKey?: string | null;
};
