import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
export declare class AuthController {
    private readonly auth;
    constructor(auth: AuthService);
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
