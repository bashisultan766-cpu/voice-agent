import type { OrderState } from './order-state-machine.util';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { OrderTurnIntent } from './order-intent-classifier.util';
export type ConversationTone = 'direct' | 'friendly' | 'neutral';
type ToneLeadSlot = 'product_found' | 'correction' | 'email' | 'price' | 'email_ack' | 'none';
export declare function detectConversationTone(text: string): ConversationTone;
export declare function resolveToneLead(args: {
    slot: ToneLeadSlot;
    conversationTone: ConversationTone;
    lastToneLeadUsed: string | null | undefined;
}): {
    lead: string;
    toneLeadUsed: string | null;
};
export declare function computeAllowPaymentSuggestion(args: {
    userIntent: UserUtteranceIntent;
    clsIntent: OrderTurnIntent;
    orderState: OrderState;
}): boolean;
export declare function responseIncludesPaymentSuggestion(text: string): boolean;
export {};
