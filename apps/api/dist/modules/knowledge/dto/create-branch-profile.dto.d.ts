export declare class CreateBranchProfileDto {
    storeId: string;
    branchCode?: string;
    name: string;
    city?: string;
    area?: string;
    address?: string;
    phone?: string;
    whatsapp?: string;
    email?: string;
    openingHoursJson?: Record<string, string>;
    pickupAvailable?: boolean;
    deliveryAvailable?: boolean;
    notes?: string;
    isActive?: boolean;
}
