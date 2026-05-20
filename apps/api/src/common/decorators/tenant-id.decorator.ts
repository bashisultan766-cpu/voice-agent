import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ tenantId?: string; headers: Record<string, string | string[] | undefined> }>();
  if (req.tenantId) return req.tenantId;
  if (process.env.NODE_ENV === 'production') {
    throw new UnauthorizedException('Missing tenant context');
  }
  const devTenantHeaderFallback =
    process.env.ALLOW_HEADER_TENANT_FALLBACK === 'true';
  if (devTenantHeaderFallback) {
    const raw = req.headers['x-tenant-id'];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v && typeof v === 'string' && v.trim()) return v.trim();
  }
  throw new UnauthorizedException('Missing tenant context');
});
