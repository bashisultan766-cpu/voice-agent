import { TenantsService } from './tenants.service';
export declare class TenantsController {
    private readonly tenantsService;
    constructor(tenantsService: TenantsService);
    findOne(tenantId: string, id: string): Promise<{
        id: string;
        createdAt: Date;
        name: string;
        updatedAt: Date;
        slug: string;
        deletedAt: Date | null;
    }>;
}
