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
exports.TestElevenLabsCredentialsDto = exports.TestOpenAICredentialsDto = exports.TestTwilioCredentialsDto = exports.TestDatabaseCredentialsDto = exports.TestShopifyCredentialsDto = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
function trimToOptionalString(value) {
    if (value === null || value === undefined)
        return undefined;
    if (typeof value !== 'string')
        return value;
    const t = value.trim();
    return t === '' ? undefined : t;
}
function toOptionalBoolean(value) {
    if (value === null || value === undefined || value === '')
        return undefined;
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        if (value.toLowerCase() === 'true')
            return true;
        if (value.toLowerCase() === 'false')
            return false;
    }
    return value;
}
class TestShopifyCredentialsDto {
}
exports.TestShopifyCredentialsDto = TestShopifyCredentialsDto;
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => toOptionalBoolean(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], TestShopifyCredentialsDto.prototype, "useWorkspaceDefaults", void 0);
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => trimToOptionalString(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    (0, class_validator_1.Matches)(/^(https?:\/\/)?[a-z0-9-]+\.myshopify\.com(\/.*)?$/i, {
        message: 'Shopify store URL must be a myshopify domain (e.g. your-store.myshopify.com).',
    }),
    __metadata("design:type", String)
], TestShopifyCredentialsDto.prototype, "shopifyStoreUrl", void 0);
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => trimToOptionalString(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(8),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], TestShopifyCredentialsDto.prototype, "shopifyAdminToken", void 0);
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => trimToOptionalString(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(20),
    __metadata("design:type", String)
], TestShopifyCredentialsDto.prototype, "shopifyApiVersion", void 0);
class TestDatabaseCredentialsDto {
}
exports.TestDatabaseCredentialsDto = TestDatabaseCredentialsDto;
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => toOptionalBoolean(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], TestDatabaseCredentialsDto.prototype, "useWorkspaceDefaults", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TestDatabaseCredentialsDto.prototype, "databaseUrl", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TestDatabaseCredentialsDto.prototype, "databaseAccessToken", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], TestDatabaseCredentialsDto.prototype, "databaseProvider", void 0);
class TestTwilioCredentialsDto {
}
exports.TestTwilioCredentialsDto = TestTwilioCredentialsDto;
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => toOptionalBoolean(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], TestTwilioCredentialsDto.prototype, "useWorkspaceDefaults", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Matches)(/^AC[a-fA-F0-9]{32}$/, { message: 'Twilio Account SID format is invalid.' }),
    __metadata("design:type", String)
], TestTwilioCredentialsDto.prototype, "twilioAccountSid", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    __metadata("design:type", String)
], TestTwilioCredentialsDto.prototype, "twilioAuthToken", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(30),
    __metadata("design:type", String)
], TestTwilioCredentialsDto.prototype, "twilioPhoneNumber", void 0);
class TestOpenAICredentialsDto {
}
exports.TestOpenAICredentialsDto = TestOpenAICredentialsDto;
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => toOptionalBoolean(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], TestOpenAICredentialsDto.prototype, "useWorkspaceDefaults", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(20),
    __metadata("design:type", String)
], TestOpenAICredentialsDto.prototype, "openaiApiKey", void 0);
class TestElevenLabsCredentialsDto {
}
exports.TestElevenLabsCredentialsDto = TestElevenLabsCredentialsDto;
__decorate([
    (0, class_transformer_1.Transform)(({ value }) => toOptionalBoolean(value)),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], TestElevenLabsCredentialsDto.prototype, "useWorkspaceDefaults", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    __metadata("design:type", String)
], TestElevenLabsCredentialsDto.prototype, "elevenlabsApiKey", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(200),
    __metadata("design:type", String)
], TestElevenLabsCredentialsDto.prototype, "voiceId", void 0);
//# sourceMappingURL=test-connection.dto.js.map