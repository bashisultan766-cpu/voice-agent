"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const tool_definitions_1 = require("./types/tool-definitions");
const voice_tool_schema_util_1 = require("./voice-tool-schema.util");
(0, node_test_1.default)('all bundled voice agent tools satisfy OpenAI array schema rules', () => {
    (0, voice_tool_schema_util_1.assertAllVoiceAgentToolSchemasValid)(tool_definitions_1.VOICE_AGENT_TOOLS);
});
(0, node_test_1.default)('sendPaymentEmail parameters include items.items for line objects', () => {
    const def = tool_definitions_1.VOICE_AGENT_TOOLS.find((t) => t.name === 'sendPaymentEmail');
    (0, strict_1.default)(def);
    const items = def.parameters.properties.items;
    strict_1.default.equal(items.type, 'array');
    strict_1.default.ok(items.items && typeof items.items === 'object');
    const elem = items.items;
    strict_1.default.equal(elem.type, 'object');
    strict_1.default.ok(Array.isArray(elem.required) && elem.required.includes('title'));
});
(0, node_test_1.default)('assertVoiceToolParametersValid rejects array without items', () => {
    strict_1.default.throws(() => (0, voice_tool_schema_util_1.assertVoiceToolParametersValid)('bad', {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'array' } },
    }), /array schema missing required "items"/);
});
(0, node_test_1.default)('normalizeOpenAiChatCompletionsModel maps realtime ids to gpt-4o-mini', () => {
    strict_1.default.equal((0, voice_tool_schema_util_1.normalizeOpenAiChatCompletionsModel)('gpt-realtime'), 'gpt-4o-mini');
    strict_1.default.equal((0, voice_tool_schema_util_1.normalizeOpenAiChatCompletionsModel)('gpt-4o-realtime-preview'), 'gpt-4o-mini');
    strict_1.default.equal((0, voice_tool_schema_util_1.normalizeOpenAiChatCompletionsModel)('gpt-4o-mini'), 'gpt-4o-mini');
    strict_1.default.equal((0, voice_tool_schema_util_1.normalizeOpenAiChatCompletionsModel)(''), 'gpt-4o-mini');
    strict_1.default.equal((0, voice_tool_schema_util_1.normalizeOpenAiChatCompletionsModel)(null), 'gpt-4o-mini');
});
//# sourceMappingURL=voice-tool-schema.util.test.js.map