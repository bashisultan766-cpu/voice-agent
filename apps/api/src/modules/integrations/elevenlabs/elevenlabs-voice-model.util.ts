import { Logger } from '@nestjs/common';

const perfLogger = new Logger('ElevenLabsVoiceModel');

export type ElevenLabsModelSource = 'env' | 'agent' | 'default';

export type ResolveElevenLabsModelInput = {
  /** Agent DB field (elevenlabsModel). Ignored for live Twilio voice when forceVoiceLatency is true. */
  agentModelId?: string | null;
  /** Live Twilio phone call — always prefer ELEVENLABS_LATENCY_MODEL_ID. */
  forceVoiceLatency?: boolean;
  envLatencyModelId?: string | null;
  envDefaultModelId?: string | null;
};

export type ResolveElevenLabsModelResult = {
  selectedModel: string;
  source: ElevenLabsModelSource;
  envModel: string | null;
  agentModel: string | null;
};

/** Resolve ElevenLabs model for voice commerce — never defaults to eleven_multilingual_v2 on calls. */
export function resolveElevenLabsVoiceModel(
  input: ResolveElevenLabsModelInput = {},
): ResolveElevenLabsModelResult {
  const envLatency =
    input.envLatencyModelId?.trim() ||
    process.env.ELEVENLABS_LATENCY_MODEL_ID?.trim() ||
    null;
  const agentModel = input.agentModelId?.trim() || null;

  if (input.forceVoiceLatency !== false) {
    const selectedModel = envLatency || 'eleven_turbo_v2_5';
    return {
      selectedModel,
      source: envLatency ? 'env' : 'default',
      envModel: envLatency,
      agentModel,
    };
  }

  const selectedModel = envLatency || agentModel || 'eleven_turbo_v2_5';
  const source: ElevenLabsModelSource = envLatency ? 'env' : agentModel ? 'agent' : 'default';

  return { selectedModel, source, envModel: envLatency, agentModel };
}

export function logElevenLabsModelSelected(
  result: ResolveElevenLabsModelResult,
  extra?: Record<string, unknown>,
): void {
  perfLogger.log(
    JSON.stringify({
      event: 'elevenlabs.model.selected',
      selectedModel: result.selectedModel,
      envModel: result.envModel,
      agentModel: result.agentModel,
      source: result.source,
      ...extra,
    }),
  );
}
