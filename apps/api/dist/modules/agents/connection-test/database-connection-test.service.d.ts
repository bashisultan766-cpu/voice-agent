import type { ConnectionTestResult } from './connection-test.types';
export interface DatabaseTestConfig {
    databaseUrl?: string | null;
    databaseAccessToken?: string | null;
    databaseProvider?: string | null;
}
export declare class DatabaseConnectionTestService {
    validateRequired(config: DatabaseTestConfig): string | null;
    testConnection(config: DatabaseTestConfig): Promise<ConnectionTestResult>;
    private defaultPortForScheme;
    private probeHttp;
    private probeTcp;
}
