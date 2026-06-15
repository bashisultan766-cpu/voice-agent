import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoSensitiveDynamicVariables,
  buildConversationInitiation,
  buildPersonalizedFirstMessage,
  GENERIC_FIRST_MESSAGE,
  sanitizeLastCallSummary,
} from './returning-caller-personalization.util';
import { buildRegisterCallRequestBody } from '../elevenlabs-twilio-register-call.service';

test('known caller gets personalized first message', () => {
  const initiation = buildConversationInitiation({
    callerRecognized: true,
    customerId: 'gid://shopify/Customer/1',
    customerFirstName: 'Washi',
    customerFullName: 'Washi Khan',
    totalPreviousCalls: 12,
    lastOrderNumber: '#1042',
    lastCallSummary: 'Asked about order tracking',
    callerPhoneVerified: 'partial',
  });

  assert.equal(initiation.personalized, true);
  assert.equal(
    initiation.firstMessage,
    buildPersonalizedFirstMessage('Washi'),
  );
  assert.equal(initiation.dynamicVariables.caller_recognized, 'true');
  assert.equal(initiation.dynamicVariables.customer_first_name, 'Washi');
  assert.equal(initiation.dynamicVariables.caller_phone_verified, 'partial');
  assert.equal(initiation.dynamicVariables.total_previous_calls, '12');
});

test('unknown caller gets generic first message', () => {
  const initiation = buildConversationInitiation({
    callerRecognized: false,
    customerId: null,
    customerFirstName: null,
    customerFullName: null,
    totalPreviousCalls: 0,
    lastOrderNumber: null,
    lastCallSummary: null,
    callerPhoneVerified: 'none',
  });

  assert.equal(initiation.personalized, false);
  assert.equal(initiation.firstMessage, GENERIC_FIRST_MESSAGE);
  assert.equal(initiation.dynamicVariables.caller_recognized, 'false');
  assert.equal(initiation.dynamicVariables.caller_phone_verified, 'none');
  assert.equal(initiation.dynamicVariables.customer_first_name, undefined);
});

test('known caller with missing first name gets generic first message', () => {
  const initiation = buildConversationInitiation({
    callerRecognized: true,
    customerId: 'gid://shopify/Customer/2',
    customerFirstName: null,
    customerFullName: 'Unknown Caller',
    totalPreviousCalls: 3,
    lastOrderNumber: null,
    lastCallSummary: null,
    callerPhoneVerified: 'partial',
  });

  assert.equal(initiation.personalized, false);
  assert.equal(initiation.firstMessage, GENERIC_FIRST_MESSAGE);
  assert.equal(initiation.dynamicVariables.caller_recognized, 'true');
  assert.equal(initiation.dynamicVariables.customer_first_name, '');
});

test('phone number match only sets partial verification, not full', () => {
  const initiation = buildConversationInitiation({
    callerRecognized: true,
    customerId: 'gid://shopify/Customer/3',
    customerFirstName: 'Sam',
    customerFullName: 'Sam Lee',
    totalPreviousCalls: 1,
    lastOrderNumber: '#2001',
    lastCallSummary: null,
    callerPhoneVerified: 'partial',
  });

  assert.equal(initiation.dynamicVariables.caller_phone_verified, 'partial');
  assert.notEqual(initiation.dynamicVariables.caller_phone_verified, 'full');
});

test('sensitive fields are sanitized and blocked from ElevenLabs variables', () => {
  const summary = sanitizeLastCallSummary(
    'Caller asked about refund sent to reader@example.com at 123 Main Street',
  );
  assert.match(summary, /\[email\]/);
  assert.doesNotMatch(summary, /reader@example\.com/);

  const initiation = buildConversationInitiation({
    callerRecognized: true,
    customerId: 'gid://shopify/Customer/4',
    customerFirstName: 'Alex',
    customerFullName: 'Alex Smith',
    totalPreviousCalls: 2,
    lastOrderNumber: '#3003',
    lastCallSummary: 'Refund to card 4111111111111111',
    callerPhoneVerified: 'partial',
  });

  assert.doesNotMatch(initiation.dynamicVariables.last_call_summary ?? '', /4111111111111111/);
  assert.throws(() =>
    assertNoSensitiveDynamicVariables({
      customer_email: 'secret@example.com',
    }),
  );
});

test('register-call body includes first_message override for recognized caller', () => {
  const initiation = buildConversationInitiation({
    callerRecognized: true,
    customerId: 'gid://shopify/Customer/5',
    customerFirstName: 'Washi',
    customerFullName: 'Washi Khan',
    totalPreviousCalls: 5,
    lastOrderNumber: '#1010',
    lastCallSummary: 'Book order help',
    callerPhoneVerified: 'partial',
  });

  const body = buildRegisterCallRequestBody({
    fromNumber: '+15551234567',
    toNumber: '+15559876543',
    callSid: 'CA123',
    phoneNormalized: '+15551234567',
    initiation,
  });

  const clientData = body.conversation_initiation_client_data as {
    dynamic_variables: Record<string, string>;
    conversation_config_override: { agent: { first_message: string } };
  };

  assert.equal(clientData.dynamic_variables.customer_first_name, 'Washi');
  assert.equal(clientData.dynamic_variables.caller_phone_verified, 'partial');
  assert.match(clientData.conversation_config_override.agent.first_message, /Hi Washi/);
  assert.doesNotMatch(
    JSON.stringify(clientData.dynamic_variables),
    /@[\w.-]+\.\w+/,
  );
});

test('customer lookup failure fallback uses generic greeting in register body', () => {
  const initiation = buildConversationInitiation({
    callerRecognized: false,
    customerId: null,
    customerFirstName: null,
    customerFullName: null,
    totalPreviousCalls: 0,
    lastOrderNumber: null,
    lastCallSummary: null,
    callerPhoneVerified: 'none',
  });

  const body = buildRegisterCallRequestBody({
    fromNumber: '+15550001111',
    toNumber: '+15559876543',
    callSid: 'CA999',
    initiation,
  });

  const clientData = body.conversation_initiation_client_data as {
    conversation_config_override: { agent: { first_message: string } };
  };

  assert.equal(
    clientData.conversation_config_override.agent.first_message,
    GENERIC_FIRST_MESSAGE,
  );
});
