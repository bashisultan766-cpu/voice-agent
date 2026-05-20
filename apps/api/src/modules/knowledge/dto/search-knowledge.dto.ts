import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';

export class SearchKnowledgeDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  branchProfileId?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number;
}
