import { IsString, IsOptional, IsBoolean, IsInt, Min, MaxLength } from 'class-validator';

export class CreateFaqDto {
  @IsString()
  storeId: string;

  @IsOptional()
  @IsString()
  branchProfileId?: string;

  @IsString()
  @MaxLength(1000)
  question: string;

  @IsString()
  @MaxLength(5000)
  answer: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsString()
  tags?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
