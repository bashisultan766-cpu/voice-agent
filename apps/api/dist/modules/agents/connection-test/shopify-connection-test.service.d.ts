import type { ConnectionTestResult } from './connection-test.types';
export interface ShopifyTestConfig {
    shopifyStoreUrl?: string | null;
    shopifyAdminToken?: string | null;
}
export declare class ShopifyConnectionTestService {
    validateRequired(config: ShopifyTestConfig): string | null;
    testConnection(config: ShopifyTestConfig): Promise<ConnectionTestResult>;
    private messageFromStatus;
}
