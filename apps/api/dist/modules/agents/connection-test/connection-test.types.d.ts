export interface ConnectionTestResult {
    success: boolean;
    message: string;
    shop?: {
        name?: string;
        domain?: string;
        email?: string;
    };
    code?: string;
    warnings?: string[];
}
