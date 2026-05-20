import { IsEmail, IsOptional, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterDto {
  /** Display name for the workspace / organization. */
  @Transform(({ obj }) => String(obj.workspaceName ?? obj.organizationName ?? '').trim())
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  workspaceName!: string;

  /**
   * Optional URL slug (lowercase letters, numbers, hyphens). If omitted, a slug is derived from the workspace name.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value == null || value === '') return undefined;
    return String(value).trim().toLowerCase();
  })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Workspace slug may only contain lowercase letters, numbers, and single hyphens.',
  })
  workspaceSlug?: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName!: string;
}
