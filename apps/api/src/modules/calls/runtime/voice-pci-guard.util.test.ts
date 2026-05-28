import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assessVoiceToolPciRisk,
  callerSpeechContainsRawCardData,
} from './voice-pci-guard.util';
import { voiceCheckoutPreconditionMet } from './voice-checkout-flow.util';
import { emptyLlmAgentState } from './llm-agent-conversation-state.util';

describe('assessVoiceToolPciRisk', () => {
  it('allows getProductDetails with Shopify variant GID', () => {
    const result = assessVoiceToolPciRisk('getProductDetails', {
      variantId: 'gid://shopify/ProductVariant/447654321098765',
      productId: 'gid://shopify/Product/8234567890123',
      title: 'Atomic Habits',
    });
    assert.equal(result.blocked, false);
    assert.equal(result.permissionDecision, 'allow_hosted_checkout');
  });

  it('allows createCheckoutLink with email and variant line items', () => {
    const result = assessVoiceToolPciRisk('createCheckoutLink', {
      email: 'john@gmail.com',
      items: [
        {
          variantId: 'gid://shopify/ProductVariant/447654321098765',
          quantity: 1,
        },
      ],
    });
    assert.equal(result.blocked, false);
  });

  it('blocks raw card number in free-text fields', () => {
    const result = assessVoiceToolPciRisk('searchProducts', {
      query: '4111111111111111',
    });
    assert.equal(result.blocked, true);
    assert.match(result.pciRestrictionReason ?? '', /luhn|card/i);
  });

  it('blocks forbidden card keys on checkout tools', () => {
    const result = assessVoiceToolPciRisk('createCheckoutLink', {
      email: 'buyer@example.com',
      cardNumber: '4111111111111111',
      items: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1 }],
    });
    assert.equal(result.blocked, true);
    assert.equal(result.pciRestrictionReason, 'forbidden_key:cardNumber');
  });
});

describe('callerSpeechContainsRawCardData', () => {
  it('detects spoken card numbers', () => {
    assert.equal(callerSpeechContainsRawCardData('my card is 4111 1111 1111 1111'), true);
  });

  it('does not flag normal email', () => {
    assert.equal(callerSpeechContainsRawCardData('john@gmail.com'), false);
  });
});

describe('voiceCheckoutPreconditionMet', () => {
  it('allows checkout when llm state has in-stock selection', () => {
    const state = emptyLlmAgentState();
    state.selectedProducts = [
      {
        title: 'Atomic Habits',
        variantId: 'gid://shopify/ProductVariant/99',
        inStock: true,
        stock: 5,
      },
    ];
    state.checkoutStage = 'product_selected';
    assert.equal(voiceCheckoutPreconditionMet('IDLE', state), true);
  });
});
