import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

@ValidatorConstraint({ name: 'loginWorkspaceSlugPresent', async: false })
class LoginWorkspaceSlugPresent implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments) {
    const o = args.object as LoginDto;
    const raw = o.workspaceSlug ?? o.tenantSlug;
    return typeof raw === 'string' && raw.trim().length >= 2;
  }

  defaultMessage() {
    return 'workspaceSlug must be at least 2 characters';
  }
}

export class LoginDto {
  /** Workspace slug from registration (e.g. acme-corp). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  workspaceSlug?: string;

  /** Legacy alias; retained so ValidationPipe whitelist keeps it for slug resolution. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  tenantSlug?: string;

  @Validate(LoginWorkspaceSlugPresent)
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

/** Resolves workspace slug from login body (workspaceSlug preferred over legacy tenantSlug). */
export function resolveLoginWorkspaceSlug(dto: LoginDto): string {
  return (dto.workspaceSlug ?? dto.tenantSlug ?? '').trim().toLowerCase();
}
