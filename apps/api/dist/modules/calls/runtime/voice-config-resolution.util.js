"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveOpenAiKeyChain = resolveOpenAiKeyChain;
exports.openAiKeyLayerPresence = openAiKeyLayerPresence;
exports.resolveElevenLabsKeyChain = resolveElevenLabsKeyChain;
function trimOrNull(s) {
    const t = s?.trim();
    return t ? t : null;
}
function resolveOpenAiKeyChain(args) {
    const agent = trimOrNull(args.agentSecretPlain);
    if (agent)
        return { value: agent, source: 'agent' };
    if (args.encryptionAvailable && args.tenantEnc) {
        const dec = args.decryptFromStorage(args.tenantEnc);
        const t = trimOrNull(dec);
        if (t)
            return { value: t, source: 'tenant' };
    }
    const env = trimOrNull(args.envPlain ?? process.env.OPENAI_API_KEY);
    if (env)
        return { value: env, source: 'env' };
    return { value: null, source: 'none' };
}
function openAiKeyLayerPresence(args) {
    return {
        agentKeyPresent: Boolean(trimOrNull(args.agentSecretPlain)),
        tenantKeyPresent: Boolean(args.tenantEnc?.trim()),
        envKeyPresent: Boolean(trimOrNull(args.envPlain ?? process.env.OPENAI_API_KEY)),
    };
}
function resolveElevenLabsKeyChain(args) {
    const agent = trimOrNull(args.agentSecretPlain);
    if (agent)
        return { value: agent, source: 'agent' };
    if (args.encryptionAvailable && args.tenantEnc) {
        const dec = args.decryptFromStorage(args.tenantEnc);
        const t = trimOrNull(dec);
        if (t)
            return { value: t, source: 'tenant' };
    }
    const env = trimOrNull(args.envPlain ?? process.env.ELEVENLABS_API_KEY);
    if (env)
        return { value: env, source: 'env' };
    return { value: null, source: 'none' };
}
//# sourceMappingURL=voice-config-resolution.util.js.map