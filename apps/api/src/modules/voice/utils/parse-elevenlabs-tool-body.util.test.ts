import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flattenElevenLabsToolBody,
  resolveCallSidFromToolBody,
  resolvePhoneNumberFromToolBody,
  resolveSendPaymentLinkFieldsFromToolBody,
} from './parse-elevenlabs-tool-body.util';

test('flattenElevenLabsToolBody unwraps parameters', () => {
  const flat = flattenElevenLabsToolBody({
    tool_call_id: 'tc_1',
    parameters: {
      email: 'a@b.com',
      callSid: 'CA123',
    },
  });
  assert.equal(flat.email, 'a@b.com');
  assert.equal(flat.callSid, 'CA123');
  assert.equal(flat.tool_call_id, 'tc_1');
});

test('resolveCallSidFromToolBody reads system__call_sid', () => {
  assert.equal(
    resolveCallSidFromToolBody({ parameters: { system__call_sid: 'CA999' } }),
    'CA999',
  );
});

test('resolvePhoneNumberFromToolBody reads caller_phone', () => {
  assert.equal(
    resolvePhoneNumberFromToolBody({ parameters: { caller_phone: '+923001234567' } }),
    '+923001234567',
  );
});

test('resolveSendPaymentLinkFieldsFromToolBody', () => {
  const fields = resolveSendPaymentLinkFieldsFromToolBody({
    parameters: {
      email: 'test@gmail.com',
      variantId: 'gid://shopify/ProductVariant/1',
      quantity: 2,
      call_sid: 'CAabc',
      phone: '+12025551234',
    },
  });
  assert.equal(fields.email, 'test@gmail.com');
  assert.equal(fields.quantity, 2);
  assert.equal(fields.callSid, 'CAabc');
  assert.equal(fields.phoneNumber, '+12025551234');
});

test('resolveSendPaymentLinkFieldsFromToolBody reads emailConfirmed', () => {
  const fields = resolveSendPaymentLinkFieldsFromToolBody({
    parameters: {
      email: 'test@gmail.com',
      emailConfirmed: true,
      variantId: 'gid://shopify/ProductVariant/1',
      quantity: 1,
    },
  });
  assert.equal(fields.emailConfirmed, true);
});

test('resolveSendPaymentLinkFieldsFromToolBody reads emailComfirmed typo key', () => {
  const fields = resolveSendPaymentLinkFieldsFromToolBody({
    parameters: {
      email: 'buyer@mycompany.com',
      emailComfirmed: 'true',
      variantId: 'gid://shopify/ProductVariant/1',
      quantity: 1,
    },
  });
  assert.equal(fields.emailConfirmed, true);
});

test('resolveSendPaymentLinkFieldsFromToolBody normalizes yes/no values', () => {
  const yesFields = resolveSendPaymentLinkFieldsFromToolBody({
    parameters: {
      email: 'buyer@mycompany.com',
      email_confirmed: 'yes',
      variantId: 'gid://shopify/ProductVariant/1',
      quantity: 1,
    },
  });
  const noFields = resolveSendPaymentLinkFieldsFromToolBody({
    parameters: {
      email: 'buyer@mycompany.com',
      email_comfirmed: 'no',
      variantId: 'gid://shopify/ProductVariant/1',
      quantity: 1,
    },
  });
  assert.equal(yesFields.emailConfirmed, true);
  assert.equal(noFields.emailConfirmed, false);
});

test('resolveSendPaymentLinkFieldsFromToolBody reads productName aliases', () => {
  const fields = resolveSendPaymentLinkFieldsFromToolBody({
    parameters: {
      email: 'buyer@sureshotbooks.com',
      book_title: 'A Game of Thrones',
      quantity: 1,
    },
  });
  assert.equal(fields.productName, 'A Game of Thrones');
});
