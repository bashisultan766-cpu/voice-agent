import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

const ROLE_RANK: Record<UserRole, number> = {
  SUPPORT: 1,
  MANAGER: 2,
  ADMIN: 3,
  OWNER: 4,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles =
      this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (requiredRoles.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ userRole?: UserRole }>();
    const userRole = req.userRole;
    if (!userRole) {
      throw new ForbiddenException('Insufficient permissions.');
    }

    const minimumRequired = requiredRoles.reduce((max, role) =>
      ROLE_RANK[role] > max ? ROLE_RANK[role] : max,
    0);
    if (ROLE_RANK[userRole] < minimumRequired) {
      throw new ForbiddenException('Insufficient permissions.');
    }
    return true;
  }
}
