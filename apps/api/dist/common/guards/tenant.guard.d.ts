import { CanActivate, ExecutionContext } from '@nestjs/common';
export declare const TENANT_HEADER = "x-tenant-id";
export declare class TenantGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean;
}
