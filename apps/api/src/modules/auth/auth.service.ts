import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto, resolveLoginWorkspaceSlug } from './dto/login.dto';

function slugify(s: string): string {
  const x = s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return x || 'workspace';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const existingEmail = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    if (existingEmail) {
      throw new ConflictException(
        'This email is already registered. Sign in with your workspace slug, or use a different email.',
      );
    }

    let slug: string;
    if (dto.workspaceSlug?.trim()) {
      slug = dto.workspaceSlug.trim().toLowerCase();
      const taken = await this.prisma.tenant.findFirst({
        where: { slug, deletedAt: null },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException('This workspace slug is already taken. Choose another.');
      }
    } else {
      const baseSlug = slugify(dto.workspaceName);
      slug = baseSlug;
      let n = 0;
      while (await this.prisma.tenant.findFirst({ where: { slug, deletedAt: null } })) {
        slug = `${baseSlug}-${++n}`;
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const tenant = await this.prisma.tenant.create({
      data: { name: dto.workspaceName.trim(), slug },
    });
    try {
      const user = await this.prisma.user.create({
        data: {
          tenantId: tenant.id,
          email,
          fullName: dto.fullName.trim(),
          passwordHash,
          role: 'OWNER',
        },
      });
      await this.prisma.client.create({
        data: {
          tenantId: tenant.id,
          name: `${tenant.name} — default`,
          contactEmail: email,
        },
      });
      const accessToken = this.jwt.sign({ sub: user.id });
      return {
        accessToken,
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
      };
    } catch (e: unknown) {
      await this.prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined);
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : '';
      if (code === 'P2002') {
        throw new ConflictException('This email or workspace slug is already in use.');
      }
      throw new UnauthorizedException('Registration failed.');
    }
  }

  /**
   * Login succeeds only when workspace slug, email, and password all match the same user.
   * A correct email/password for another workspace must not authenticate.
   */
  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();
    const workspaceSlug = resolveLoginWorkspaceSlug(dto);
    const invalid = () =>
      new UnauthorizedException('Invalid workspace, email, or password');

    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: workspaceSlug, deletedAt: null },
    });
    if (!tenant) throw invalid();

    const user = await this.prisma.user.findFirst({
      where: { tenantId: tenant.id, email, deletedAt: null },
    });
    if (!user?.passwordHash) throw invalid();

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw invalid();
    const accessToken = this.jwt.sign({ sub: user.id });
    return {
      accessToken,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { tenant: true },
    });
    if (!user || user.tenant.deletedAt) throw new UnauthorizedException();
    return {
      tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
    };
  }
}
