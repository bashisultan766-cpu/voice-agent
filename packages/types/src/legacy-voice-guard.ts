/**
 * Legacy Next.js ConversationRelay voice path (apps/web/lib/voice/*).
 * Production inbound voice uses the API Gather MVP flow with per-agent credentials.
 */
export function isLegacyWebVoicePathAllowed(nodeEnv?: string): boolean {
  return nodeEnv !== 'production';
}

export const LEGACY_WEB_VOICE_PRODUCTION_BLOCK_MESSAGE =
  'Legacy web voice path is disabled in production. Use the API Twilio Gather voice runtime.';
