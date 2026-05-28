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
