"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIToolRegistryService = void 0;
const common_1 = require("@nestjs/common");
const tool_definitions_1 = require("./types/tool-definitions");
const voice_tool_schema_util_1 = require("./voice-tool-schema.util");
let OpenAIToolRegistryService = class OpenAIToolRegistryService {
    onModuleInit() {
        (0, voice_tool_schema_util_1.assertAllVoiceAgentToolSchemasValid)(tool_definitions_1.VOICE_AGENT_TOOLS);
    }
    getToolsForAgent(enabledTools) {
        const allowed = this.getAllowedToolNames(enabledTools);
        return tool_definitions_1.VOICE_AGENT_TOOLS.filter((t) => allowed.includes(t.name)).map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
    }
    getAllowedToolNames(enabledTools) {
        if (Array.isArray(enabledTools) && enabledTools.length > 0) {
            return enabledTools.filter((name) => tool_definitions_1.ALL_TOOL_NAMES.includes(name));
        }
        return tool_definitions_1.ALL_TOOL_NAMES;
    }
    isToolAllowed(toolName, enabledTools) {
        return this.getAllowedToolNames(enabledTools).includes(toolName);
    }
};
exports.OpenAIToolRegistryService = OpenAIToolRegistryService;
exports.OpenAIToolRegistryService = OpenAIToolRegistryService = __decorate([
    (0, common_1.Injectable)()
], OpenAIToolRegistryService);
//# sourceMappingURL=openai-tool-registry.service.js.map