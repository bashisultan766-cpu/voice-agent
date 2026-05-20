import { PrismaService } from '../../../database/prisma.service';
export interface ResolvedAgentContext {
    tenantId: string;
    storeId: string | null;
    agentId: string;
    phoneNumberId: string | null;
    agent: {
        name: string;
        voice?: string | null;
        voiceProvider?: string | null;
        voiceId?: string | null;
        language: string;
        baseSystemPrompt: string;
        greetingMessage?: string | null;
        fallbackMessage?: string | null;
        escalationMessage?: string | null;
        model?: string | null;
        temperature?: number | null;
    };
    store: {
        name: string;
        city?: string | null;
        timezone?: string | null;
    };
}
export declare class AgentResolutionService {
    private readonly prisma;
    private readonly log;
    constructor(prisma: PrismaService);
    private hasAmbiguousTenantAssignment;
    resolveByPhoneNumber(toNumber: string): Promise<ResolvedAgentContext | null>;
}
