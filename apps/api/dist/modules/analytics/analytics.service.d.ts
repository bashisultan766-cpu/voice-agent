import { PrismaService } from '../../database/prisma.service';
export declare class AnalyticsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    getOverview(tenantId: string, from?: Date, to?: Date): Promise<{
        totalCalls: number;
        resolutionRate: number;
        escalationRate: number;
        conversionRate: number;
        avgDurationSeconds: number;
        callbackRequestCount: number;
        topProductsRequested: {
            title: string;
            count: number;
        }[];
    }>;
    getAgentMetrics(tenantId: string, from?: Date, to?: Date): Promise<{
        resolutionRate: number;
        escalationRate: number;
        avgDurationSeconds: number;
        avgToolCalls: number;
        agentId: string;
        agentName: string;
        total: number;
        resolved: number;
        escalated: number;
        totalDuration: number;
        totalToolCalls: number;
        toolFailures: number;
    }[]>;
    getStoreMetrics(tenantId: string, from?: Date, to?: Date): Promise<{
        resolutionRate: number;
        escalationRate: number;
        storeId: string;
        storeName: string;
        total: number;
        resolved: number;
        escalated: number;
    }[]>;
    getToolMetrics(tenantId: string, from?: Date, to?: Date): Promise<{
        toolName: string;
        totalCalls: number;
        successCount: number;
        failureCount: number;
        successRate: number;
        avgLatencyMs: number;
    }[]>;
}
