import { AgentsService } from './agents.service';
export declare class PublicAgentsController {
    private readonly agentsService;
    constructor(agentsService: AgentsService);
    liveCard(id: string): Promise<{
        name: string;
        storeName: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        isActive: boolean;
        language: string;
        phone: string | null;
        greeting: string | null;
    }>;
}
