import { IsOptional, IsBoolean, IsNumber, Min, Max, IsString } from 'class-validator';

export class CreateQaReviewDto {
  @IsOptional()
  @IsString()
  reviewerUserId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  accuracyScore?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  toneScore?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  policyComplianceScore?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  brevityScore?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  needsPromptUpdate?: boolean;

  @IsOptional()
  @IsBoolean()
  needsFaqUpdate?: boolean;
}
