/**
 * One-shot boot check — ConversationRelay needs VOICE_ID only.
 */
import {
  getHealthVoiceProviderLabel,
  getLockedElevenLabsVoiceId,
  initializeGlobalVoiceProvider,
  resetElevenLabsCircuitBreakerForTests,
} from "../src/adapters/voiceAdapter.js";
import { getConfig, isConversationRelayRuntime } from "../src/config.js";

async function main(): Promise<void> {
  const cfg = getConfig();
  resetElevenLabsCircuitBreakerForTests();
  const provider = await initializeGlobalVoiceProvider();

  const result = {
    voiceRuntime: cfg.VOICE_RUNTIME,
    conversationRelay: isConversationRelayRuntime(),
    provider,
    healthLabel: getHealthVoiceProviderLabel(),
    voiceId: getLockedElevenLabsVoiceId(),
    requiresElevenLabsApiKey: cfg.VOICE_RUNTIME === "twilio_media_streams",
  };

  console.log(JSON.stringify(result, null, 2));

  if (!getLockedElevenLabsVoiceId()) {
    process.exit(1);
  }
  if (isConversationRelayRuntime() && provider !== "ElevenLabs") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
