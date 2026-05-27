import { z } from 'zod';
export declare const cuidParamSchema: z.ZodString;
export declare const updateAgentStatusBodySchema: z.ZodObject<{
    status: z.ZodEnum<["draft", "active", "paused"]>;
}, "strict", z.ZodTypeAny, {
    status: "draft" | "active" | "paused";
}, {
    status: "draft" | "active" | "paused";
}>;
export declare const logsQuerySchema: z.ZodObject<{
    limit: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    limit?: number | undefined;
}, {
    limit?: number | undefined;
}>;
export declare const testAiBehaviorBodySchema: z.ZodDefault<z.ZodObject<{
    sampleQuery: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    sampleQuery?: string | undefined;
}, {
    sampleQuery?: string | undefined;
}>>;
export declare const testShopifyCredentialsSchema: z.ZodDefault<z.ZodObject<{
    useWorkspaceDefaults: z.ZodOptional<z.ZodBoolean>;
    shopifyStoreUrl: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, string | undefined>>;
    shopifyAdminToken: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    shopifyStoreUrl?: string | undefined;
    shopifyAdminToken?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}, {
    shopifyStoreUrl?: string | undefined;
    shopifyAdminToken?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}>>;
export declare const testDatabaseCredentialsSchema: z.ZodDefault<z.ZodObject<{
    useWorkspaceDefaults: z.ZodOptional<z.ZodBoolean>;
    databaseUrl: z.ZodOptional<z.ZodString>;
    databaseAccessToken: z.ZodOptional<z.ZodString>;
    databaseProvider: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    databaseProvider?: string | undefined;
    databaseUrl?: string | undefined;
    databaseAccessToken?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}, {
    databaseProvider?: string | undefined;
    databaseUrl?: string | undefined;
    databaseAccessToken?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}>>;
export declare const testTwilioCredentialsSchema: z.ZodDefault<z.ZodObject<{
    useWorkspaceDefaults: z.ZodOptional<z.ZodBoolean>;
    twilioAccountSid: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, string | undefined>>;
    twilioAuthToken: z.ZodOptional<z.ZodString>;
    twilioPhoneNumber: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    twilioPhoneNumber?: string | undefined;
    twilioAccountSid?: string | undefined;
    twilioAuthToken?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}, {
    twilioPhoneNumber?: string | undefined;
    twilioAccountSid?: string | undefined;
    twilioAuthToken?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}>>;
export declare const testOpenAiCredentialsSchema: z.ZodDefault<z.ZodObject<{
    useWorkspaceDefaults: z.ZodOptional<z.ZodBoolean>;
    openaiApiKey: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    openaiApiKey?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}, {
    openaiApiKey?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}>>;
export declare const testElevenLabsCredentialsSchema: z.ZodDefault<z.ZodObject<{
    useWorkspaceDefaults: z.ZodOptional<z.ZodBoolean>;
    elevenlabsApiKey: z.ZodOptional<z.ZodString>;
    voiceId: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    voiceId?: string | undefined;
    elevenlabsApiKey?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}, {
    voiceId?: string | undefined;
    elevenlabsApiKey?: string | undefined;
    useWorkspaceDefaults?: boolean | undefined;
}>>;
export declare const testAgentEmailBodySchema: z.ZodDefault<z.ZodObject<{
    toEmail: z.ZodOptional<z.ZodString>;
    checkoutUrl: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
}, "strict", z.ZodTypeAny, {
    checkoutUrl?: string | undefined;
    toEmail?: string | undefined;
}, {
    checkoutUrl?: string | undefined;
    toEmail?: string | undefined;
}>>;
export declare const configureTwilioWebhookBodySchema: z.ZodDefault<z.ZodObject<{
    force: z.ZodOptional<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
    force?: boolean | undefined;
}, {
    force?: boolean | undefined;
}>>;
export declare const smokeTestBodySchema: z.ZodDefault<z.ZodObject<{
    dryRun: z.ZodOptional<z.ZodBoolean>;
    sampleSpeechResult: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    sampleSpeechResult?: string | undefined;
    dryRun?: boolean | undefined;
}, {
    sampleSpeechResult?: string | undefined;
    dryRun?: boolean | undefined;
}>>;
export declare const debugShopifySearchBodySchema: z.ZodObject<{
    query: z.ZodString;
}, "strict", z.ZodTypeAny, {
    query: string;
}, {
    query: string;
}>;
