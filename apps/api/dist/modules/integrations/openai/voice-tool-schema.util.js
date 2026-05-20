"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertVoiceToolParametersValid = assertVoiceToolParametersValid;
exports.assertAllVoiceAgentToolSchemasValid = assertAllVoiceAgentToolSchemasValid;
exports.normalizeOpenAiChatCompletionsModel = normalizeOpenAiChatCompletionsModel;
function walkJsonSchemaFragment(node, path) {
    if (node === null || node === undefined)
        return;
    if (typeof node !== 'object' || Array.isArray(node))
        return;
    const o = node;
    const t = o.type;
    if (t === 'array') {
        if (!('items' in o) || o.items === undefined) {
            throw new Error(`${path}: array schema missing required "items"`);
        }
        walkJsonSchemaFragment(o.items, `${path}.items`);
    }
    if (t === 'object' && o.properties !== undefined && typeof o.properties === 'object' && !Array.isArray(o.properties)) {
        for (const [key, val] of Object.entries(o.properties)) {
            walkJsonSchemaFragment(val, `${path}.properties.${key}`);
        }
    }
}
function assertVoiceToolParametersValid(toolName, parameters) {
    if (parameters.type !== 'object') {
        throw new Error(`Tool "${toolName}": parameters root must be type "object"`);
    }
    walkJsonSchemaFragment(parameters, `tool:${toolName}.parameters`);
}
function assertAllVoiceAgentToolSchemasValid(tools) {
    for (const t of tools) {
        assertVoiceToolParametersValid(t.name, t.parameters);
    }
}
function normalizeOpenAiChatCompletionsModel(model) {
    const raw = model?.trim();
    if (!raw)
        return 'gpt-4o-mini';
    if (/realtime/i.test(raw))
        return 'gpt-4o-mini';
    return raw;
}
//# sourceMappingURL=voice-tool-schema.util.js.map