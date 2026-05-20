"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateKnowledgeDocumentDto = void 0;
const mapped_types_1 = require("@nestjs/mapped-types");
const create_knowledge_document_dto_1 = require("./create-knowledge-document.dto");
class UpdateKnowledgeDocumentDto extends (0, mapped_types_1.PartialType)(create_knowledge_document_dto_1.CreateKnowledgeDocumentDto) {
}
exports.UpdateKnowledgeDocumentDto = UpdateKnowledgeDocumentDto;
//# sourceMappingURL=update-knowledge-document.dto.js.map