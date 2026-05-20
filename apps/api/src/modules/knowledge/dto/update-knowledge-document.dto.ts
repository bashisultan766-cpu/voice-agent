import { PartialType } from '@nestjs/mapped-types';
import { CreateKnowledgeDocumentDto } from './create-knowledge-document.dto';

export class UpdateKnowledgeDocumentDto extends PartialType(CreateKnowledgeDocumentDto) {}
