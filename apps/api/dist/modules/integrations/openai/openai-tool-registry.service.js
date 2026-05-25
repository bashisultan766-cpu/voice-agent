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
exports.OpenAIToolRegistryService = void 0;
const common_1 = require("@nestjs/common");
const runtime_tool_registry_service_1 = require("../../tools/runtime-tool-registry.service");
let OpenAIToolRegistryService = class OpenAIToolRegistryService {
    constructor(runtimeRegistry) {
        this.runtimeRegistry = runtimeRegistry;
    }
    getToolsForAgent(filter) {
        const params = Array.isArray(filter) ? { enabledTools: filter } : (filter ?? {});
        return this.runtimeRegistry.getToolsForAgent(params);
    }
    getAllowedToolNames(filter) {
        const params = Array.isArray(filter) ? { enabledTools: filter } : (filter ?? {});
        return this.runtimeRegistry.resolveEnabledToolNames(params);
    }
    isToolAllowed(toolName, filter) {
        const params = Array.isArray(filter) ? { enabledTools: filter } : (filter ?? {});
        return this.runtimeRegistry.isToolAllowed(toolName, params);
    }
};
exports.OpenAIToolRegistryService = OpenAIToolRegistryService;
exports.OpenAIToolRegistryService = OpenAIToolRegistryService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [runtime_tool_registry_service_1.RuntimeToolRegistryService])
], OpenAIToolRegistryService);
//# sourceMappingURL=openai-tool-registry.service.js.map