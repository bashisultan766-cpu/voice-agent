"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoginDto = void 0;
exports.resolveLoginWorkspaceSlug = resolveLoginWorkspaceSlug;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
let LoginWorkspaceSlugPresent = class LoginWorkspaceSlugPresent {
    validate(_, args) {
        const o = args.object;
        const raw = o.workspaceSlug ?? o.tenantSlug;
        return typeof raw === 'string' && raw.trim().length >= 2;
    }
    defaultMessage() {
        return 'workspaceSlug must be at least 2 characters';
    }
};
LoginWorkspaceSlugPresent = __decorate([
    (0, class_validator_1.ValidatorConstraint)({ name: 'loginWorkspaceSlugPresent', async: false })
], LoginWorkspaceSlugPresent);
class LoginDto {
}
exports.LoginDto = LoginDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(2),
    (0, class_validator_1.MaxLength)(80),
    __metadata("design:type", String)
], LoginDto.prototype, "workspaceSlug", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(2),
    (0, class_validator_1.MaxLength)(80),
    __metadata("design:type", String)
], LoginDto.prototype, "tenantSlug", void 0);
__decorate([
    (0, class_validator_1.Validate)(LoginWorkspaceSlugPresent),
    (0, class_validator_1.IsEmail)(),
    __metadata("design:type", String)
], LoginDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(128),
    __metadata("design:type", String)
], LoginDto.prototype, "password", void 0);
function resolveLoginWorkspaceSlug(dto) {
    return (dto.workspaceSlug ?? dto.tenantSlug ?? '').trim().toLowerCase();
}
//# sourceMappingURL=login.dto.js.map