import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { IS_PUBLIC_KEY } from '../../common/constants';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      tenantId?: string;
      userId?: string;
      userEmail?: string;
      userRole?: UserRole;
    }>();
    const authHeader = req.headers?.authorization;
    const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;

    const devTenantHeaderFallback =
      process.env.NODE_ENV !== 'production' &&
      process.env.ALLOW_HEADER_TENANT_FALLBACK === 'true';
    if (!token && devTenantHeaderFallback) {
      const raw = req.headers['x-tenant-id'];
      const tid = Array.isArray(raw) ? raw[0] : raw;
      if (tid && typeof tid === 'string' && tid.trim()) {
        req.tenantId = tid.trim();
        return true;
      }
    }

    if (!token) {
      throw new UnauthorizedException(
        'Authentication required. Sign in and send Authorization: Bearer <access_token> on API requests.',
      );
    }

    let payload: { sub: string };
    try {
      payload = this.jwt.verify<{ sub: string }>(token);
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired access token. Sign in again to obtain a new token.',
      );
    }

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      include: { tenant: true },
    });
    if (!user || user.tenant.deletedAt) {
      throw new UnauthorizedException(
        'Account not found or tenant disabled. Sign in again or contact an administrator.',
      );
    }
    req.tenantId = user.tenantId;
    req.userId = user.id;
    req.userEmail = user.email;
    req.userRole = user.role;
    return true;
  }
}
