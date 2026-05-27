import { type OrderState } from './order-state-machine.util';
import type { OrderTurnClassification, OrderTurnIntent } from './order-intent-classifier.util';
export type OrderTurnUpdate = {
    nextState: OrderState;
    recoveryPrompt?: {
        key: RecoveryPromptKey;
    };
};
export type RecoveryPromptKey = 'UNCLEAR_PRODUCT' | 'INVALID_EMAIL' | 'CHANGED_MIND' | 'NEED_PRODUCT_FIRST' | 'CONFIRM_QUANTITY' | 'RESEND_PAYMENT_LINK';
export declare function applyTurnToOrderState(currentRaw: unknown, intent: OrderTurnIntent, cls: OrderTurnClassification): OrderTurnUpdate;
export declare function recoveryPromptText(languageCode: string | null | undefined, key: RecoveryPromptKey): string;
