import { z } from 'zod';
import {
  AGENT_FIELD_LIMITS,
  getHostnameFromShopifyInput,
  isMyshopifyDomain,
} from '@/components/agents/form-types';

const urlPattern = /^https?:\/\/.+/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const L = AGENT_FIELD_LIMITS;

const optionalEmail = z
  .string()
  .max(255)
  .refine((v) => !v.trim() || emailPattern.test(v.trim()), {
    message: 'Enter a valid email address or leave this field blank.',
  });

const optionalUrl = z
  .string()
  .max(500)
  .refine((v) => !v.trim() || urlPattern.test(v.trim()), {
    message: 'Enter a full URL starting with https:// or leave this field blank.',
  });

const shopifyField = z
  .string()
  .max(500)
  .optional()
  .or(z.literal(''))
  .superRefine((val, ctx) => {
    const s = (val ?? '').trim();
    if (!s) return;
    const host = getHostnameFromShopifyInput(s);
    if (!host || !isMyshopifyDomain(host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Use the myshopify.com domain from Shopify Admin (for example your-store.myshopify.com).',
      });
    }
  });

/** Tenant UI does not collect DB URLs; optional for internal/API compatibility. */
const optionalDatabaseUrl = z.string().max(2000).optional().or(z.literal(''));

/** Full create / update payload — aligned with client `validateCreateAgentForm` and Nest `CreateAgentDto`. */
export const createAgentFullSchema = z
  .object({
    clientId: z.string().optional().or(z.literal('')),
    storeId: z.string().min(1, 'Store is required.'),
    useWorkspaceDefaults: z.boolean().optional(),
    agentName: z.string().min(1, 'Give your voice agent a short name.'),
    storeName: z.string().min(1, 'Store name is required.'),
    businessName: z.string().max(200).optional().or(z.literal('')),
    agentStatus: z.enum(['draft', 'active', 'paused']).default('draft'),
    language: z.string().min(2).max(50).default('en'),
    timezone: z.string().min(1).max(100).default('UTC'),
    storeUrl: optionalUrl,
    storeEmail: optionalEmail,
    supportEmail: optionalEmail,
    supportPhone: z.string().max(30).optional().or(z.literal('')),
    databaseAccessToken: z.string().max(500).optional().or(z.literal('')),

    voiceProvider: z.string().max(100).optional().or(z.literal('')),
    voiceId: z.string().max(200).optional().or(z.literal('')),
    elevenlabsModel: z.string().max(120).optional().or(z.literal('')),
    voiceStyle: z.string().max(100).optional().or(z.literal('')),
    languageMode: z.enum(['auto', 'fixed']).default('auto'),
    fixedLanguage: z.string().max(50).optional().or(z.literal('')),
    supportedLanguages: z.array(z.string().max(16)).default(['en', 'ur', 'hi', 'ar', 'es', 'fr', 'de']),
    openaiApiKey: z
      .string()
      .optional()
      .or(z.literal(''))
      .superRefine((v, ctx) => {
        const t = (v ?? '').trim();
        if (t && t.length < 20) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'OpenAI API key looks too short.',
          });
        }
      }),
    elevenlabsApiKey: z
      .string()
      .optional()
      .or(z.literal(''))
      .superRefine((v, ctx) => {
        const t = (v ?? '').trim();
        if (t && t.length < 10) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'ElevenLabs API key looks too short.',
          });
        }
      }),
    greetingMessage: z.string().max(L.greetingMessage).optional().or(z.literal('')),
    fallbackMessage: z.string().max(L.fallbackMessage).optional().or(z.literal('')),

    shopifyStoreUrl: shopifyField,
    shopifyStoreNumber: z.string().max(100).optional().or(z.literal('')),
    shopifyAdminToken: z.string().optional().or(z.literal('')),
    shopifyApiKey: z.string().optional().or(z.literal('')),
    shopifyApiSecret: z.string().optional().or(z.literal('')),
    webhookSecret: z.string().optional().or(z.literal('')),

    databaseProvider: z.string().max(100).optional().or(z.literal('')),
    databaseUrl: optionalDatabaseUrl,
    knowledgeBaseSource: z.string().max(200).optional().or(z.literal('')),
    knowledgeSyncEnabled: z.boolean().default(true),

    twilioAccountSid: z.string().optional().or(z.literal('')),
    twilioAuthToken: z.string().optional().or(z.literal('')),
    twilioPhoneNumber: z.string().max(30).optional().or(z.literal('')),
    callRoutingMode: z.string().max(50).optional().or(z.literal('')),
    incomingCallHandling: z.string().max(50).optional().or(z.literal('')),

    promptTemplate: z.string().optional().or(z.literal('')),
    systemPrompt: z.string().max(L.systemPrompt).optional().or(z.literal('')),
    agentRole: z.string().max(L.agentRole).optional().or(z.literal('')),
    toneOfVoice: z.string().max(100).optional().or(z.literal('')),
    agentGoal: z.string().max(L.agentGoal).optional().or(z.literal('')),
    allowedActions: z.string().max(L.allowedActions).optional().or(z.literal('')),
    restrictedActions: z.string().max(L.restrictedActions).optional().or(z.literal('')),
    escalationInstructions: z.string().max(L.escalationInstructions).optional().or(z.literal('')),
    forbiddenBehaviors: z.string().max(L.forbiddenBehaviors).optional().or(z.literal('')),
    escalationRules: z.union([z.string(), z.array(z.string())]).optional(),

    askEmailBeforePaymentLink: z.boolean().default(true),
    checkoutMode: z.enum(['cart', 'draft_order']).default('cart'),
    humanHandoffRules: z.string().max(L.humanHandoffRules).optional().or(z.literal('')),
    shippingPolicy: z.string().max(L.policyText).optional().or(z.literal('')),
    returnPolicy: z.string().max(L.policyText).optional().or(z.literal('')),
    exchangePolicy: z.string().max(L.policyText).optional().or(z.literal('')),
    deliveryNotes: z.string().max(L.policyText).optional().or(z.literal('')),

    returnRefundBehavior: z.string().max(L.returnRefundBehavior).optional().or(z.literal('')),
    orderStatusHandling: z.string().max(L.orderStatusHandling).optional().or(z.literal('')),
    outOfStockHandling: z.string().max(L.outOfStockHandling).optional().or(z.literal('')),
    transferToHumanEnabled: z.boolean().default(true),
    escalationPhone: z.string().max(30).optional().or(z.literal('')),
    escalationEmail: optionalEmail,
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const provider = (data.voiceProvider ?? '').trim().toLowerCase();
    if (provider === 'elevenlabs') {
      if (!(data.voiceId ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['voiceId'],
          message: 'Voice ID is required for ElevenLabs.',
        });
      }
      if (!(data.elevenlabsApiKey ?? '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['elevenlabsApiKey'],
          message: 'ElevenLabs API key is required when ElevenLabs voice is selected.',
        });
      }
    }
    if (data.languageMode === 'fixed' && !(data.fixedLanguage ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixedLanguage'],
        message: 'Choose a fixed language, or switch to auto-detect mode.',
      });
    }
  });

/** Draft save: only require identity fields; rest is passthrough for persistence. */
export const createAgentDraftSchema = z
  .object({
    agentName: z.string().min(1, 'Add at least an agent name to save a draft.'),
    storeName: z.string().min(1, 'Add a store name to save a draft.'),
  })
  .passthrough();

export type CreateAgentSchemaInput = z.infer<typeof createAgentFullSchema>;

/** @deprecated Use `createAgentFullSchema` — kept for incremental imports. */
export const createAgentSchema = createAgentFullSchema;
