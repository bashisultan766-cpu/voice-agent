import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
export declare class HealthController {
    private readonly prisma;
    private readonly config;
    constructor(prisma: PrismaService, config: ConfigService);
    check(): Promise<{
        env: string;
        status: string;
    }>;
    ready(): Promise<{
        status: string;
        reason?: undefined;
    } | {
        status: string;
        reason: string;
    }>;
}
