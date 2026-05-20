/**
 * OpenAI Chat Completions `functions[].parameters` must be valid JSON Schema.
 * Arrays with `type: "array"` require a nested `items` schema or the API returns 400.
 */

function walkJsonSchemaFragment(node: unknown, path: string): void {
  if (node === null || node === undefined) return;
  if (typeof node !== 'object' || Array.isArray(node)) return;

  const o = node as Record<string, unknown>;
  const t = o.type;

  if (t === 'array') {
    if (!('items' in o) || o.items === undefined) {
      throw new Error(`${path}: array schema missing required "items"`);
    }
    walkJsonSchemaFragment(o.items, `${path}.items`);
  }

  if (t === 'object' && o.properties !== undefined && typeof o.properties === 'object' && !Array.isArray(o.properties)) {
    for (const [key, val] of Object.entries(o.properties as Record<string, unknown>)) {
      walkJsonSchemaFragment(val, `${path}.properties.${key}`);
    }
  }
}

/** Validate one tool's `parameters` object (root must be type object per OpenAI tools). */
export function assertVoiceToolParametersValid(toolName: string, parameters: Record<string, unknown>): void {
  if (parameters.type !== 'object') {
    throw new Error(`Tool "${toolName}": parameters root must be type "object"`);
  }
  walkJsonSchemaFragment(parameters, `tool:${toolName}.parameters`);
}

export function assertAllVoiceAgentToolSchemasValid(
  tools: ReadonlyArray<{ name: string; parameters: Record<string, unknown> }>,
): void {
  for (const t of tools) {
    assertVoiceToolParametersValid(t.name, t.parameters);
  }
}

/** Map realtime speech models to a chat-completions-compatible id. */
export function normalizeOpenAiChatCompletionsModel(model: string | undefined | null): string {
  const raw = model?.trim();
  if (!raw) return 'gpt-4o-mini';
  if (/realtime/i.test(raw)) return 'gpt-4o-mini';
  return raw;
}
