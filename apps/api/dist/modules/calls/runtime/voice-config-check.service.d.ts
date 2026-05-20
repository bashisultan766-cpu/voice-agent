import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import { type VoiceCredentialSource } from './voice-config-resolution.util';
export type VoiceConfigCheckResponse = {
    resolvedAgentId: string;
    tenantId: string;
    openaiKeySource: VoiceCredentialSource;
    openaiKeyPresent: boolean;
    agentOpenaiKeyStored: boolean;
    tenantOpenaiKeyStored: boolean;
    agentKeyPresent: boolean;
    tenantKeyPresent: boolean;
    envKeyPresent: boolean;
    agentOverridesWorkspaceOpenai: boolean;
    model: string | null;
    voiceProvider: string | null;
    voiceIdPresent: boolean;
    elevenLabsKeySource: VoiceCredentialSource;
    publicWebhookBaseUrlValid: boolean;
    twilioNumberMapped: boolean;
    warnings: string[];
};
export declare class VoiceConfigCheckService {
    private readonly prisma;
    private readonly encryption;
    private readonly config;
    constructor(prisma: PrismaService, encryption: EncryptionService, config: ConfigService);
    check(tenantId: string, agentId: string): Promise<VoiceConfigCheckResponse>;
}
