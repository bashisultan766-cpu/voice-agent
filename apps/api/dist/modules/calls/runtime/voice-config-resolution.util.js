"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveOpenAiKeyChain = resolveOpenAiKeyChain;
exports.openAiKeyLayerPresence = openAiKeyLayerPresence;
exports.resolveElevenLabsKeyChain = resolveElevenLabsKeyChain;
const provider_env_fallback_util_1 = require("../../../common/provider-env-fallback.util");
function trimOrNull(s) {
    const t = s?.trim();
    return t ? t : null;
}
function gatedEnvPlain(envPlain) {
    if (!(0, provider_env_fallback_util_1.allowProviderEnvFallback)())
        return null;
    return trimOrNull(envPlain);
}
function resolveOpenAiKeyChain(args) {
    const agent = trimOrNull(args.agentSecretPlain);
    if (agent)
        return { value: agent, source: 'agent' };
    if (args.useWorkspaceOpenai === true && args.encryptionAvailable && args.tenantEnc) {
        const dec = args.decryptFromStorage(args.tenantEnc);
        const t = trimOrNull(dec);
        if (t)
            return { value: t, source: 'tenant' };
    }
    const env = gatedEnvPlain(args.envPlain);
    if (env)
        return { value: env, source: 'env' };
    return { value: null, source: 'none' };
}
function openAiKeyLayerPresence(args) {
    return {
        agentKeyPresent: Boolean(trimOrNull(args.agentSecretPlain)),
        tenantKeyPresent: args.useWorkspaceOpenai === true ? Boolean(args.tenantEnc?.trim()) : false,
        envKeyPresent: Boolean(gatedEnvPlain(args.envPlain)),
    };
}
function resolveElevenLabsKeyChain(args) {
    const agent = trimOrNull(args.agentSecretPlain);
    if (agent)
        return { value: agent, source: 'agent' };
    if (args.useWorkspaceElevenlabs === true && args.encryptionAvailable && args.tenantEnc) {
        const dec = args.decryptFromStorage(args.tenantEnc);
        const t = trimOrNull(dec);
        if (t)
            return { value: t, source: 'tenant' };
    }
    const env = gatedEnvPlain(args.envPlain);
    if (env)
        return { value: env, source: 'env' };
    return { value: null, source: 'none' };
}
//# sourceMappingURL=voice-config-resolution.util.js.map