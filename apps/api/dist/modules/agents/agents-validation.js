"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugShopifySearchBodySchema = exports.smokeTestBodySchema = exports.configureTwilioWebhookBodySchema = exports.testElevenLabsCredentialsSchema = exports.testOpenAiCredentialsSchema = exports.testTwilioCredentialsSchema = exports.testDatabaseCredentialsSchema = exports.testShopifyCredentialsSchema = exports.testAiBehaviorBodySchema = exports.logsQuerySchema = exports.cuidParamSchema = void 0;
const zod_1 = require("zod");
exports.cuidParamSchema = zod_1.z.string().min(20).max(32).regex(/^c[a-z0-9]+$/i);
exports.logsQuerySchema = zod_1.z
    .object({
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
})
    .strict();
const optionalTrimmed = zod_1.z.string().trim().min(1).optional();
exports.testAiBehaviorBodySchema = zod_1.z
    .object({
    sampleQuery: zod_1.z.string().trim().min(1).max(1000).optional(),
})
    .strict()
    .default({});
exports.testShopifyCredentialsSchema = zod_1.z
    .object({
    useWorkspaceDefaults: zod_1.z.boolean().optional(),
    shopifyStoreUrl: optionalTrimmed
        .refine((value) => !value || /^(https?:\/\/)?[a-z0-9-]+\.myshopify\.com(\/.*)?$/i.test(value), {
        message: 'Shopify store URL must be a myshopify domain (e.g. your-store.myshopify.com).',
    })
        .optional(),
    shopifyAdminToken: optionalTrimmed,
})
    .strict()
    .default({});
exports.testDatabaseCredentialsSchema = zod_1.z
    .object({
    useWorkspaceDefaults: zod_1.z.boolean().optional(),
    databaseUrl: optionalTrimmed,
    databaseAccessToken: optionalTrimmed,
    databaseProvider: optionalTrimmed,
})
    .strict()
    .default({});
exports.testTwilioCredentialsSchema = zod_1.z
    .object({
    useWorkspaceDefaults: zod_1.z.boolean().optional(),
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
exports.testOpenAiCredentialsSchema = zod_1.z
    .object({
    useWorkspaceDefaults: zod_1.z.boolean().optional(),
    openaiApiKey: optionalTrimmed,
})
    .strict()
    .default({});
exports.testElevenLabsCredentialsSchema = zod_1.z
    .object({
    useWorkspaceDefaults: zod_1.z.boolean().optional(),
    elevenlabsApiKey: optionalTrimmed,
    voiceId: optionalTrimmed,
})
    .strict()
    .default({});
exports.configureTwilioWebhookBodySchema = zod_1.z
    .object({
    force: zod_1.z.boolean().optional(),
})
    .strict()
    .default({});
exports.smokeTestBodySchema = zod_1.z
    .object({
    dryRun: zod_1.z.boolean().optional(),
    sampleSpeechResult: zod_1.z.string().trim().min(1).max(500).optional(),
})
    .strict()
    .default({});
exports.debugShopifySearchBodySchema = zod_1.z
    .object({
    query: zod_1.z.string().trim().min(1).max(500),
})
    .strict();
//# sourceMappingURL=agents-validation.js.map