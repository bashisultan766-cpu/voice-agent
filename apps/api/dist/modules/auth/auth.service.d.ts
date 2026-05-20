import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
export declare class AuthService {
    private readonly prisma;
    private readonly jwt;
    constructor(prisma: PrismaService, jwt: JwtService);
    register(dto: RegisterDto): Promise<{
        accessToken: string;
        tenant: {
            id: string;
            name: string;
            slug: string;
        };
        user: {
            id: string;
            email: string;
            fullName: string | null;
            role: import("@prisma/client").$Enums.UserRole;
        };
    }>;
    login(dto: LoginDto): Promise<{
        accessToken: string;
        tenant: {
            id: string;
            name: string;
            slug: string;
        };
        user: {
            id: string;
            email: string;
            fullName: string | null;
            role: import("@prisma/client").$Enums.UserRole;
        };
    }>;
    me(userId: string): Promise<{
        tenant: {
            id: string;
            name: string;
            slug: string;
        };
        user: {
            id: string;
            email: string;
            fullName: string | null;
            role: import("@prisma/client").$Enums.UserRole;
        };
    }>;
}
