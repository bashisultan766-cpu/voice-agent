import { ClientsService } from './clients.service';
export declare class ClientsController {
    private readonly clientsService;
    constructor(clientsService: ClientsService);
    findAll(tenantId: string): Promise<{
        id: string;
        createdAt: Date;
        name: string;
        tenantId: string;
        updatedAt: Date;
        contactEmail: string | null;
        contactPhone: string | null;
    }[]>;
}
