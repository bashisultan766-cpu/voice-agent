"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateBranchProfileDto = void 0;
const mapped_types_1 = require("@nestjs/mapped-types");
const create_branch_profile_dto_1 = require("./create-branch-profile.dto");
class UpdateBranchProfileDto extends (0, mapped_types_1.PartialType)(create_branch_profile_dto_1.CreateBranchProfileDto) {
}
exports.UpdateBranchProfileDto = UpdateBranchProfileDto;
//# sourceMappingURL=update-branch-profile.dto.js.map