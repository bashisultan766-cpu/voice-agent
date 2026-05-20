export type VoiceCredentialSource = 'agent' | 'tenant' | 'env' | 'none';
export type ResolvedSecret = {
    value: string | null;
    source: VoiceCredentialSource;
};
export declare function resolveOpenAiKeyChain(args: {
    agentSecretPlain: string | null | undefined;
    tenantEnc: string | null | undefined;
    decryptFromStorage: (enc: string) => string | null;
    envPlain: string | null | undefined;
    encryptionAvailable: boolean;
}): ResolvedSecret;
export declare function openAiKeyLayerPresence(args: {
    agentSecretPlain: string | null | undefined;
    tenantEnc: string | null | undefined;
    envPlain: string | null | undefined;
}): {
    agentKeyPresent: boolean;
    tenantKeyPresent: boolean;
    envKeyPresent: boolean;
};
export declare function resolveElevenLabsKeyChain(args: {
    agentSecretPlain: string | null | undefined;
    tenantEnc: string | null | undefined;
    decryptFromStorage: (enc: string) => string | null;
    envPlain: string | null | undefined;
    encryptionAvailable: boolean;
}): ResolvedSecret;
