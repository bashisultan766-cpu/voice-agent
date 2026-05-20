import 'reflect-metadata';
import { PrismaService } from '../database/prisma.service';
import { INestApplicationContext } from '@nestjs/common';
export type DevScriptContext = {
    tenantId: string;
    agentId: string;
    callSessionId?: string;
};
export declare function requireEnv(name: string): string;
export declare function optionalEnv(name: string): string | undefined;
export declare function assertTenantAgentContext(prisma: PrismaService, tenantId: string, agentId: string): Promise<void>;
export declare function withDevAppContext<T>(fn: (app: INestApplicationContext) => Promise<T>): Promise<T>;
