"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var OpenAIConnectionTestService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIConnectionTestService = void 0;
const common_1 = require("@nestjs/common");
const common_2 = require("@nestjs/common");
let OpenAIConnectionTestService = OpenAIConnectionTestService_1 = class OpenAIConnectionTestService {
    constructor() {
        this.log = new common_2.Logger(OpenAIConnectionTestService_1.name);
    }
    validateRequired(config) {
        const key = config.openaiApiKey?.trim();
        if (!key)
            return 'OpenAI API key is required to test the connection.';
        return null;
    }
    sanitizeErrorText(raw) {
        if (!raw)
            return '';
        return raw
            .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****')
            .replace(/sk-proj-[A-Za-z0-9_-]{8,}/g, 'sk-proj-****')
            .slice(0, 240);
    }
    resolveFailureMessage(status, text) {
        const lowered = text.toLowerCase();
        if (status === 401) {
            if (lowered.includes('project') || lowered.includes('organization')) {
                return 'OpenAI rejected this API key. Check the key and organization/project settings.';
            }
            return 'OpenAI rejected this API key. Check the key or project permissions.';
        }
        if (status === 403)
            return 'OpenAI key does not have permission for this operation.';
        if (status === 429)
            return 'OpenAI quota/rate limit reached.';
        if (lowered.includes('project') || lowered.includes('organization') || lowered.includes('org_')) {
            return 'OpenAI organization/project mismatch. Confirm the key belongs to the correct project.';
        }
        return `OpenAI API returned ${status}.`;
    }
    async testConnection(config) {
        const validationError = this.validateRequired(config);
        if (validationError)
            return { success: false, message: validationError };
        const apiKey = config.openaiApiKey.trim();
        this.log.log(JSON.stringify({
            provider: 'openai',
            operation: 'test',
            hasApiKey: true,
            keyLength: apiKey.length,
        }));
        try {
            const res = await fetch('https://api.openai.com/v1/models?limit=1', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                const clean = this.sanitizeErrorText(text);
                this.log.warn(JSON.stringify({
                    provider: 'openai',
                    operation: 'test',
                    hasApiKey: true,
                    keyLength: apiKey.length,
                    responseStatus: res.status,
                    error: clean,
                }));
                return { success: false, message: this.resolveFailureMessage(res.status, clean) };
            }
            this.log.log(JSON.stringify({
                provider: 'openai',
                operation: 'test',
                hasApiKey: true,
                keyLength: apiKey.length,
                responseStatus: res.status,
            }));
            return { success: true, message: 'OpenAI connection successful.' };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const clean = this.sanitizeErrorText(message);
            this.log.warn(JSON.stringify({
                provider: 'openai',
                operation: 'test',
                hasApiKey: true,
                keyLength: apiKey.length,
                error: clean,
            }));
            if (message.includes('fetch') || message.includes('Failed') || message.includes('ENOTFOUND') || message.includes('ECONN')) {
                return { success: false, message: 'Could not reach OpenAI API.' };
            }
            return { success: false, message: `OpenAI connection failed: ${clean}` };
        }
    }
};
exports.OpenAIConnectionTestService = OpenAIConnectionTestService;
exports.OpenAIConnectionTestService = OpenAIConnectionTestService = OpenAIConnectionTestService_1 = __decorate([
    (0, common_1.Injectable)()
], OpenAIConnectionTestService);
//# sourceMappingURL=openai-connection-test.service.js.map