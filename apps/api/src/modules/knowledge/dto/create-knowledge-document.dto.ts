import { IsString, IsOptional, IsBoolean, IsEnum, MaxLength } from 'class-validator';
import { KnowledgeDocType, KnowledgeStatus } from '@prisma/client';

export class CreateKnowledgeDocumentDto {
  @IsString()
  storeId: string;

  @IsOptional()
  @IsString()
  branchProfileId?: string;

  @IsString()
  @MaxLength(500)
  title: string;

  @IsEnum(KnowledgeDocType)
  type: KnowledgeDocType;

  @IsOptional()
  @IsEnum(KnowledgeStatus)
  status?: KnowledgeStatus;

  @IsOptional()
  @IsString()
  language?: string;

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsBoolean()
  isVoiceOptimized?: boolean;
}
