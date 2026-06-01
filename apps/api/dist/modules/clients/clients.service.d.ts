import { PrismaService } from '../../database/prisma.service';
export declare class ClientsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    findAll(tenantId: string): Promise<{
        id: string;
        tenantId: string;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        contactEmail: string | null;
        contactPhone: string | null;
    }[]>;
}
