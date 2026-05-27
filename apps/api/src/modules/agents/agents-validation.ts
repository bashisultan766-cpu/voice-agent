import { z } from 'zod';

export const cuidParamSchema = z.string().min(20).max(32).regex(/^c[a-z0-9]+$/i);

export const updateAgentStatusBodySchema = z
  .object({
    status: z.enum(['draft', 'active', 'paused']),
  })
  .strict();

export const logsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const optionalTrimmed = z.string().trim().min(1).optional();

export const testAiBehaviorBodySchema = z
  .object({
    sampleQuery: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .default({});

export const testShopifyCredentialsSchema = z
  .object({
    useWorkspaceDefaults: z.boolean().optional(),
    shopifyStoreUrl: optionalTrimmed
      .refine((value) => !value || /^(https?:\/\/)?[a-z0-9-]+\.myshopify\.com(\/.*)?$/i.test(value), {
        message:
          'Shopify store URL must be a myshopify domain (e.g. your-store.myshopify.com).',
      })
      .optional(),
    shopifyAdminToken: optionalTrimmed,
  })
  .strict()
  .default({});

export const testDatabaseCredentialsSchema = z
  .object({
    useWorkspaceDefaults: z.boolean().optional(),
    databaseUrl: optionalTrimmed,
    databaseAccessToken: optionalTrimmed,
    databaseProvider: optionalTrimmed,
  })
  .strict()
  .default({});

export const testTwilioCredentialsSchema = z
  .object({
    useWorkspaceDefaults: z.boolean().optional(),
    twilioAccountSid: optionalTrimmed
      .refine((value) => !value || /^AC[a-fA-F0-9]{32}$/.test(value), {
        message: 'Twilio Account SID format is invalid.',
      })
      .optional(),
    twilioAuthToken: optionalTrimmed,
    twilioPhoneNumber: optionalTrimmed,
  })
  .strict()
  .default({});

export const testOpenAiCredentialsSchema = z
  .object({
    useWorkspaceDefaults: z.boolean().optional(),
    openaiApiKey: optionalTrimmed,
  })
  .strict()
  .default({});

export const testElevenLabsCredentialsSchema = z
  .object({
    useWorkspaceDefaults: z.boolean().optional(),
    elevenlabsApiKey: optionalTrimmed,
    voiceId: optionalTrimmed,
  })
  .strict()
  .default({});

export const testAgentEmailBodySchema = z
  .object({
    toEmail: z.string().trim().email().optional(),
    checkoutUrl: z
      .string()
      .trim()
      .url()
      .refine((u) => u.startsWith('https://'), { message: 'checkoutUrl must use HTTPS.' })
      .optional(),
  })
  .strict()
  .default({});

export const configureTwilioWebhookBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict()
  .default({});

export const smokeTestBodySchema = z
  .object({
    dryRun: z.boolean().optional(),
    sampleSpeechResult: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .default({});

export const debugShopifySearchBodySchema = z
  .object({
    query: z.string().trim().min(1).max(500),
  })
  .strict();
