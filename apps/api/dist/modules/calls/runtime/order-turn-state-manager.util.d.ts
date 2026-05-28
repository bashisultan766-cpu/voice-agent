import { type OrderState } from './order-state-machine.util';
import type { OrderTurnClassification, OrderTurnIntent } from './order-intent-classifier.util';
export type OrderTurnUpdate = {
    nextState: OrderState;
    recoveryPrompt?: {
        key: RecoveryPromptKey;
    };
    stateInterrupted?: {
        fromState: string;
        toIntent: InterruptibleIntent;
        reason: string;
    };
};
export type RecoveryPromptKey = 'UNCLEAR_PRODUCT' | 'INVALID_EMAIL' | 'CHANGED_MIND' | 'NEED_PRODUCT_FIRST' | 'CONFIRM_QUANTITY' | 'RESEND_PAYMENT_LINK';
export type InterruptibleIntent = 'product_search' | 'order_lookup' | 'support_question' | 'pricing_question';
export declare function getIntentPriority(intent: string): number;
export declare function canInterruptCurrentState(intent: string, state: unknown, confidence?: number): {
    canInterrupt: boolean;
    reason: string;
};
export declare function applyTurnToOrderState(currentRaw: unknown, intent: OrderTurnIntent, cls: OrderTurnClassification, options?: {
    alternateIntent?: string;
    alternateIntentConfidence?: number;
}): OrderTurnUpdate;
export declare function recoveryPromptText(languageCode: string | null | undefined, key: RecoveryPromptKey): string;
