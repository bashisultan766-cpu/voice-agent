import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isShopifyInvalidEmailDomainError,
  SHOPIFY_INVALID_EMAIL_DOMAIN_PATTERNS,
} from './shopify-email-domain.util';

test('isShopifyInvalidEmailDomainError matches Shopify draft-order domain errors', () => {
  assert.equal(isShopifyInvalidEmailDomainError('Email contains an invalid domain name'), true);
  assert.equal(isShopifyInvalidEmailDomainError('Email is invalid'), true);
  assert.equal(isShopifyInvalidEmailDomainError('INVALID_VARIANT_ID'), false);
});

test('SHOPIFY_INVALID_EMAIL_DOMAIN_PATTERNS is non-empty', () => {
  assert.ok(SHOPIFY_INVALID_EMAIL_DOMAIN_PATTERNS.length >= 2);
});
