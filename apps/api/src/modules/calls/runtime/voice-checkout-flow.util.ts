import type { LlmAgentConversationState } from './llm-agent-conversation-state.util';
import { isLlmProductInStock } from './voice-stock-sales-policy.util';

export function voiceCheckoutPreconditionMet(
  orderStateRaw: unknown,
  llmState: LlmAgentConversationState,
): boolean {
  const orderState = typeof orderStateRaw === 'string' ? orderStateRaw.trim().toUpperCase() : '';
  const advancedStates = new Set([
    'PRODUCT_SEARCH',
    'PRODUCT_DISCOVERY',
    'PRODUCT_CONFIRMED',
    'QUANTITY_COLLECTED',
    'EMAIL_COLLECTING',
    'EMAIL_CONFIRMING',
    'PAYMENT_LINK_CREATING',
    'PAYMENT_LINK_SENT',
    'DONE',
  ]);
  if (advancedStates.has(orderState)) return true;

  if (llmState.selectedProducts.some((p) => isLlmProductInStock(p))) return true;
  if (llmState.lastSearchedProducts.some((p) => isLlmProductInStock(p))) return true;
  if (llmState.checkoutStage !== 'idle' && llmState.checkoutStage !== 'product_discovery') {
    return true;
  }

  return false;
}

export function resolveCheckoutLineItemsFromLlmState(
  llmState: LlmAgentConversationState,
): Array<{ variantId: string; quantity: number; productId?: string; title?: string }> {
  const selected =
    llmState.selectedProducts.find((p) => isLlmProductInStock(p) && p.variantId) ??
    llmState.lastSearchedProducts.find((p) => isLlmProductInStock(p) && p.variantId);
  if (!selected?.variantId) return [];

  const qty =
    llmState.quantities[selected.variantId] ??
    (Object.values(llmState.quantities)[0] as number | undefined) ??
    1;

  return [
    {
      variantId: selected.variantId,
      productId: selected.productId,
      title: selected.title,
      quantity: Math.max(1, Math.trunc(qty)),
    },
  ];
}
