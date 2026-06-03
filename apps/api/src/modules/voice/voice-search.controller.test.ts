import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { mapGetProductResponse, VoiceSearchController } from './voice-search.controller';

test('get-product requires query isbn sku or search', async () => {
  const controller = new VoiceSearchController({ searchProduct: async () => ({ success: true, products: [] }) } as never);
  await assert.rejects(() => controller.getProduct({}), BadRequestException);
});

test('get-product resolves isbn query param and maps quantity', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controller = new VoiceSearchController({
    searchProduct: async (args: Record<string, unknown>) => {
      calls.push(args);
      return {
        success: true,
        products: [
          {
            productId: '1',
            variantId: 'gid://shopify/ProductVariant/1',
            title: 'Test Book',
            price: '9.99',
            inventory: 3,
            image: null,
            sku: '978',
            inStock: true,
            score: 1,
          },
        ],
      };
    },
  } as never);

  const result = await controller.getProduct({ isbn: '9780143127550', limit: 5 });
  assert.equal(calls[0]?.query, '9780143127550');
  assert.equal(result.products[0]?.quantity, 3);
  assert.equal(result.products[0]?.inventory, 3);
});

test('mapGetProductResponse adds quantity from inventory', () => {
  const mapped = mapGetProductResponse({
    success: true,
    products: [
      {
        productId: '1',
        variantId: 'v1',
        title: 'A',
        price: '1',
        inventory: 7,
        image: null,
        sku: null,
        inStock: true,
        score: 1,
      },
    ],
  });
  assert.equal(mapped.products[0]?.quantity, 7);
});
