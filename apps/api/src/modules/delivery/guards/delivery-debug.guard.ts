import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Debug delivery routes: allowed in non-production, or when ENABLE_DEV_OPS_ENDPOINTS=true.
 */
@Injectable()
export class DeliveryDebugGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (process.env.NODE_ENV !== 'production') return true;
    if (process.env.ENABLE_DEV_OPS_ENDPOINTS === 'true') return true;
    throw new ForbiddenException(
      'Delivery debug endpoints are disabled in production. Set ENABLE_DEV_OPS_ENDPOINTS=true for controlled testing.',
    );
  }
}
