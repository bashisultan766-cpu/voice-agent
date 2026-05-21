import { PrismaService } from '../../database/prisma.service';
export declare class ClientsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    findAll(tenantId: string): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        contactEmail: string | null;
        contactPhone: string | null;
    }[]>;
}
