export declare class LoginDto {
    workspaceSlug?: string;
    tenantSlug?: string;
    email: string;
    password: string;
}
export declare function resolveLoginWorkspaceSlug(dto: LoginDto): string;
