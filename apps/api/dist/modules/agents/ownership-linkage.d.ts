export declare function assertProductionOwnershipRequired(params: {
    nodeEnv: string | undefined;
    clientId: string | null | undefined;
    storeId: string | null | undefined;
}): void;
export declare function assertTenantOwnership(params: {
    tenantId: string;
    clientTenantId?: string | null;
    storeTenantId?: string | null;
}): void;
