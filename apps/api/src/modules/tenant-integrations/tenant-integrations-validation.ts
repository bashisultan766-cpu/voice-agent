import { z } from 'zod';

const fromEmailField = z
  .string()
  .trim()
  .min(1, 'From email is required.')
  .email('From email must be valid.')
  .transform((value) => value.toLowerCase());

const testRecipientEmailField = z
  .string()
  .trim()
  .min(1, 'Test recipient email is required.')
  .email('Test recipient email must be valid.')
  .transform((value) => value.toLowerCase());

export const emailTestBodySchema = z
  .object({
    /** Omit to use the saved workspace key (after Save). */
    apiKey: z.string().trim().min(1).optional(),
    fromEmail: fromEmailField,
    testRecipientEmail: testRecipientEmailField,
    /** Optional display name for `Name <email>` From header during connection test. */
    fromName: z.string().trim().max(120).optional(),
  })
  .strict();

export const emailSaveBodySchema = z
  .object({
    /** Omit to keep the current encrypted Resend key; `fromEmail` still updates. */
    apiKey: z.string().trim().min(1).optional(),
    fromEmail: fromEmailField,
  })
  .strict();

const twilioAccountSidField = z
  .string({ required_error: 'Account SID is required.' })
  .trim()
  .min(1, 'Account SID is required.')
  .regex(
    /^AC[a-z0-9]{32}$/i,
    'Account SID should look like AC followed by 32 letters/numbers.',
  );

const twilioAuthTokenOptionalField = z
  .string({ required_error: 'Auth token is required.' })
  .trim()
  .min(1, 'Auth token is required.')
  .optional();

const twilioPhoneNumberField = z
  .string({ required_error: 'Phone number is required.' })
  .trim()
  .min(1, 'Phone number is required.')
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be in E.164 format (e.g. +15551234567).');

export const twilioSaveBodySchema = z
  .object({
    accountSid: twilioAccountSidField,
    authToken: twilioAuthTokenOptionalField,
    phoneNumber: twilioPhoneNumberField,
    skipConnectionTest: z.boolean().optional(),
  })
  .strict();

export const twilioTestBodySchema = z
  .object({
    accountSid: twilioAccountSidField,
    authToken: twilioAuthTokenOptionalField,
    phoneNumber: twilioPhoneNumberField.optional(),
  })
  .strict();

export const twilioConfigureWebhookBodySchema = z.object({}).strict();
