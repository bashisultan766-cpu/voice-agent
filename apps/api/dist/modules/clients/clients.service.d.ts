import { PrismaService } from '../../database/prisma.service';
export declare class ClientsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    findAll(tenantId: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        contactEmail: string | null;
        contactPhone: string | null;
    }[]>;
}
