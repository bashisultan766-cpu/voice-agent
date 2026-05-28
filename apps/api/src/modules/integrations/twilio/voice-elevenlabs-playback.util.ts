/** Collapse whitespace only — full OpenAI reply is spoken without truncation. */
export function prepareVoiceTtsInputText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export const ELEVENLABS_PLAYBACK_CONTENT_TYPE = 'audio/mpeg';

export function buildTtsPlaybackUrl(publicOrigin: string, token: string): string {
  const base = publicOrigin.replace(/\/$/, '');
  return `${base}/api/twilio/voice/tts/${encodeURIComponent(token)}`;
}

export function isLikelyMpegAudio(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  if (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) return true;
  return false;
}

export function validateTtsAudioBuffer(audio: Buffer): {
  valid: boolean;
  reason?: string;
  contentType: typeof ELEVENLABS_PLAYBACK_CONTENT_TYPE;
} {
  const contentType = ELEVENLABS_PLAYBACK_CONTENT_TYPE;
  if (!audio.length) {
    return { valid: false, reason: 'empty_audio', contentType };
  }
  if (!isLikelyMpegAudio(audio)) {
    return { valid: false, reason: 'invalid_mpeg_audio', contentType };
  }
  return { valid: true, contentType };
}
