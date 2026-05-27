"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envSchema = void 0;
exports.parseEnv = parseEnv;
exports.validateProductionEnv = validateProductionEnv;
exports.assertProductionEnvOrExit = assertProductionEnvOrExit;
const zod_1 = require("zod");
function optionalNonEmptyString(minLen) {
    return zod_1.z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), zod_1.z.string().min(minLen).optional());
}
exports.envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: zod_1.z.string().min(1),
    PORT: zod_1.z.coerce.number().int().positive().default(3001),
    JWT_SECRET: zod_1.z.string().min(1, 'JWT_SECRET is required'),
    JWT_EXPIRES_SECS: zod_1.z.coerce.number().int().positive().default(604800),
    ENCRYPTION_KEY: zod_1.z.string().min(16).optional(),
    CORS_ORIGIN: zod_1.z.string().optional(),
    PUBLIC_WEBHOOK_BASE_URL: zod_1.z.string().url().optional().or(zod_1.z.literal('')),
    VALIDATE_TWILIO_SIGNATURES: zod_1.z.enum(['true', 'false']).default('true'),
    TWILIO_AUTH_TOKEN: optionalNonEmptyString(8),
    TWILIO_PROXY_SHARED_SECRET: optionalNonEmptyString(12),
    API_RATE_LIMIT_WINDOW_MS: zod_1.z.coerce.number().int().positive().default(60000),
    API_RATE_LIMIT_MAX_REQUESTS: zod_1.z.coerce.number().int().positive().default(120),
    API_RATE_LIMIT_SENSITIVE_MAX: zod_1.z.coerce.number().int().positive().default(40),
    LIVE_CALL_TEST_MODE: zod_1.z.enum(['true', 'false']).default('false'),
    TRUST_PROXY: zod_1.z.enum(['true', 'false']).default('false'),
    OPENAI_API_KEY: optionalNonEmptyString(8),
    RESEND_API_KEY: optionalNonEmptyString(8),
    RESEND_FROM_EMAIL: zod_1.z.string().email().optional().or(zod_1.z.literal('')),
    ALLOW_HEADER_TENANT_FALLBACK: zod_1.z.enum(['true', 'false']).optional(),
    ENABLE_DEV_OPS_ENDPOINTS: zod_1.z.enum(['true', 'false']).optional(),
    SHOPIFY_STORE_FULL_WEBHOOK_PAYLOAD: zod_1.z.enum(['true', 'false']).optional(),
});
function parseEnv() {
    const r = exports.envSchema.safeParse(process.env);
    if (!r.success)
        return { ok: false, error: r.error };
    return { ok: true, data: r.data };
}
function validateProductionEnv() {
    const parsed = exports.envSchema.safeParse(process.env);
    const missing = [];
    if (!parsed.success) {
        missing.push(...parsed.error.issues.map((i) => String(i.path[0] ?? 'env')));
    }
    const data = parsed.success ? parsed.data : null;
    const nodeEnv = data?.NODE_ENV ?? process.env.NODE_ENV;
    if (nodeEnv === 'production') {
        if ((process.env.JWT_SECRET ?? '').length < 32) {
            missing.push('JWT_SECRET (min 32 chars in production)');
        }
        if (!process.env.ENCRYPTION_KEY?.trim()) {
            missing.push('ENCRYPTION_KEY (required in production when storing agent credentials)');
        }
        if (!process.env.PUBLIC_WEBHOOK_BASE_URL?.trim()) {
            missing.push('PUBLIC_WEBHOOK_BASE_URL');
        }
        if (process.env.VALIDATE_TWILIO_SIGNATURES !== 'false' &&
            process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true' &&
            !process.env.TWILIO_AUTH_TOKEN?.trim()) {
            missing.push('TWILIO_AUTH_TOKEN (required only when ALLOW_PROVIDER_ENV_FALLBACK=true)');
        }
        if (process.env.ALLOW_HEADER_TENANT_FALLBACK !== undefined && process.env.ALLOW_HEADER_TENANT_FALLBACK !== 'false') {
            missing.push('ALLOW_HEADER_TENANT_FALLBACK (must be exactly "false" or unset in production)');
        }
        if (process.env.RESEND_API_KEY?.trim() && !process.env.RESEND_FROM_EMAIL?.trim()) {
            missing.push('RESEND_FROM_EMAIL (required when RESEND_API_KEY is set)');
        }
    }
    if (process.env.LIVE_CALL_TEST_MODE === 'true') {
        for (const key of ['OPENAI_API_KEY', 'ENCRYPTION_KEY', 'JWT_SECRET']) {
            if (!process.env[key]?.trim())
                missing.push(key);
        }
    }
    return { ok: missing.length === 0, missing: [...new Set(missing)] };
}
function assertProductionEnvOrExit() {
    if (process.env.NODE_ENV !== 'production')
        return;
    const shape = parseEnv();
    if (!shape.ok) {
        console.error('[api] Invalid environment configuration:', shape.error.flatten().fieldErrors);
        process.exit(1);
    }
    const extra = validateProductionEnv();
    if (!extra.ok) {
        console.error('[api] Missing or invalid production environment:', extra.missing.join(', '));
        process.exit(1);
    }
    const fallbackRaw = process.env.ALLOW_HEADER_TENANT_FALLBACK;
    if (fallbackRaw !== undefined && fallbackRaw !== 'false') {
        console.error('[api] Unsafe tenant fallback setting in production:', fallbackRaw);
        process.exit(1);
    }
}
//# sourceMappingURL=env-validation.js.map