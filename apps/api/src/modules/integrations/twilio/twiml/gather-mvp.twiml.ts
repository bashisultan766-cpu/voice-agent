/**
 * Gather + Play MVP TwiML (HTTP speech loop).
 * Inbound voice should use this instead of WebSocket Stream TwiML until a realtime server exists.
 * @see https://www.twilio.com/docs/voice/twiml/gather
 */

/** Avoid Twilio default female `Say`; use Amazon Polly neural male for English emergency TTS. */
const TWILIO_SAY_VOICE_EN = 'Polly.Matthew';

function sayOpeningAttrs(language: string): string {
  const lang = (language || 'en-US').trim();
  if (lang.toLowerCase().startsWith('en')) {
    return ` voice="${escapeXmlAttribute(TWILIO_SAY_VOICE_EN)}" language="${escapeXmlAttribute(lang)}"`;
  }
  return ` language="${escapeXmlAttribute(lang)}"`;
}

/** When true, never emit &lt;Say&gt; (ElevenLabs Play or silent Gather only). */
export type TwilioSayBlockOption = { blockTwilioSay?: boolean };

export interface InboundGatherMvpTwiMLOptions extends TwilioSayBlockOption {
  /**
   * Absolute HTTPS URL Twilio POSTs to with speech results (e.g. /api/twilio/voice/gather?callSessionId=...).
   * Must be a full URL; query strings with & must be valid for XML attributes (caller should pass a safe URL).
   */
  gatherActionUrl: string;
  /** BCP 47 language for Gather speech recognition. */
  language?: string;
  /**
   * Seconds of silence after the caller stops speaking before Twilio finalizes (e.g. "2").
   * Avoid `auto` here if callers are cut off or get empty SpeechResult on noisy lines.
   */
  speechTimeout?: string;
  /** Max seconds to wait for the caller to start speaking after prompts + pause finish. */
  timeoutSeconds?: number;
  /**
   * Silence after Say/Play so the caller knows prompts ended (Twilio only listens after nested verbs complete).
   * @default 1
   */
  pauseBeforeListenSeconds?: number;
  /** Optional public URL to an audio file to play as opening prompt. */
  playbackAudioUrl?: string;
  /** Optional public URL to an audio file to play before Hangup when Gather returns empty. */
  finalFallbackAudioUrl?: string;
  /** Spoken greeting inside Gather (use for fast inbound; avoids blocking on TTS APIs). */
  openingSayText?: string;
  /** Spoken fallback after empty Gather (before Hangup). */
  finalFallbackSayText?: string;
  /** For barge-in mode, avoid nested prompt media inside Gather. */
  includePromptInsideGather?: boolean;
}

/**
 * Opening leg: greeting → Gather (speech) → optional post-Gather fallback → Hangup.
 * Step 1: pure builder only; TwilioWebhookService wires options in Step 2.
 */
export function buildInboundGatherMvpTwiML(options: InboundGatherMvpTwiMLOptions): string {
  const language = options.language ?? 'en-US';
  const speechTimeout = options.speechTimeout ?? 'auto';
  const timeoutSeconds = Number.isFinite(options.timeoutSeconds) ? Math.max(2, Math.trunc(options.timeoutSeconds as number)) : 5;
  const pauseRaw = options.pauseBeforeListenSeconds;
  const pauseBeforeListen =
    pauseRaw === undefined ? 1 : Math.max(0, Math.min(10, Math.trunc(Number(pauseRaw))));
  const includePromptInsideGather = options.includePromptInsideGather === true;

  const actionAttr = escapeXmlAttribute(options.gatherActionUrl);
  const playbackAudioUrl = options.playbackAudioUrl?.trim() ?? '';
  const finalFallbackAudioUrl = options.finalFallbackAudioUrl?.trim() ?? '';
  const blockTwilioSay = options.blockTwilioSay === true;
  const openingSayText = blockTwilioSay ? '' : (options.openingSayText?.trim() ?? '');
  const finalFallbackSayText = blockTwilioSay ? '' : (options.finalFallbackSayText?.trim() ?? '');

  const sayAttr = sayOpeningAttrs(language);
  const gatherInnerLines: string[] = [];
  if (includePromptInsideGather) {
    if (playbackAudioUrl.length > 0) gatherInnerLines.push(`    <Play>${escapeXml(playbackAudioUrl)}</Play>`);
    if (!blockTwilioSay && openingSayText.length > 0) gatherInnerLines.push(`    <Say${sayAttr}>${escapeXml(openingSayText)}</Say>`);
    if (pauseBeforeListen > 0) {
      gatherInnerLines.push(`    <Pause length="${pauseBeforeListen}"/>`);
    }
  }
  const gatherInner = gatherInnerLines.length > 0 ? `${gatherInnerLines.join('\n')}\n` : '';
  const preGatherLines: string[] = [];
  if (!includePromptInsideGather) {
    if (playbackAudioUrl.length > 0) preGatherLines.push(`  <Play>${escapeXml(playbackAudioUrl)}</Play>`);
    else if (!blockTwilioSay && openingSayText.length > 0) preGatherLines.push(`  <Say${sayAttr}>${escapeXml(openingSayText)}</Say>`);
  }
  const preGather = preGatherLines.length > 0 ? `${preGatherLines.join('\n')}\n` : '';

  const afterGatherLines: string[] = [];
  if (finalFallbackAudioUrl.length > 0) afterGatherLines.push(`  <Play>${escapeXml(finalFallbackAudioUrl)}</Play>`);
  if (!blockTwilioSay && finalFallbackSayText.length > 0) afterGatherLines.push(`  <Say${sayAttr}>${escapeXml(finalFallbackSayText)}</Say>`);
  const afterGather = afterGatherLines.length > 0 ? `${afterGatherLines.join('\n')}\n` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${preGather}  <Gather input="speech" action="${actionAttr}" method="POST" speechTimeout="${escapeXmlAttribute(speechTimeout)}" timeout="${timeoutSeconds}" language="${escapeXmlAttribute(language)}" actionOnEmptyResult="true">
${gatherInner}  </Gather>
${afterGather}  <Hangup />
</Response>`;
}

/**
 * Instant Twilio response while OpenAI / Shopify run asynchronously.
 * Prefer &lt;Play&gt; (ElevenLabs). If no audio, default is **silent** redirect (no Twilio Say) to avoid unwanted default TTS voice.
 */
export function buildDeferredVoiceKickoffTwiML(options: {
  deferPollUrl: string;
  /** ElevenLabs MP3 URL when synthesis succeeded. */
  instantPlaybackUrl?: string;
  /**
   * When no `instantPlaybackUrl` and `allowTwilioSayFallback` is true, speak this with Polly (English).
   * Default: silent redirect only.
   */
  instantSayText?: string;
  allowTwilioSayFallback?: boolean;
  /** BCP-47 for optional Say fallback. */
  language?: string;
} & TwilioSayBlockOption): string {
  const play = options.instantPlaybackUrl?.trim() ?? '';
  if (play.length > 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(play)}</Play>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
  }
  if (!options.blockTwilioSay && options.allowTwilioSayFallback) {
    const lang = options.language ?? 'en-US';
    const sayAttr = sayOpeningAttrs(lang);
    const say = (options.instantSayText ?? 'One moment.').trim();
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say${sayAttr}>${escapeXml(say)}</Say>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
}

/** Fast poll hop while deferred work is still running. */
export function buildDeferredVoicePollPauseTwiML(options: { deferPollUrl: string; pauseSeconds?: number }): string {
  const pauseRaw = options.pauseSeconds;
  const pause =
    pauseRaw === undefined ? 1 : Math.max(1, Math.min(5, Math.trunc(Number(pauseRaw))));
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="${pause}"/>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
}

/** Spoken when processing exceeds a few seconds (still non-blocking; continues polling). */
export function buildDeferredVoiceMomentPleaseTwiML(options: {
  deferPollUrl: string;
  playbackUrl?: string;
  sayFallbackText?: string;
  /** When false and no playback, silent redirect (no default female Say). */
  allowTwilioSayFallback?: boolean;
  language?: string;
} & TwilioSayBlockOption): string {
  const play = options.playbackUrl?.trim() ?? '';
  if (play.length > 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(play)}</Play>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
  }
  if (!options.blockTwilioSay && options.allowTwilioSayFallback) {
    const lang = options.language ?? 'en-US';
    const sayAttr = sayOpeningAttrs(lang);
    const say = (options.sayFallbackText ?? 'One moment please.').trim();
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say${sayAttr}>${escapeXml(say)}</Say>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
}

/**
 * Final message then hang up (no Gather). Used after max empty-speech retries.
 */
export function buildVoiceTerminalTwiml(options: {
  playbackAudioUrl?: string;
  sayText?: string;
  language?: string;
} & TwilioSayBlockOption): string {
  const play = options.playbackAudioUrl?.trim() ?? '';
  const say = options.blockTwilioSay ? '' : (options.sayText?.trim() ?? '');
  const lang = options.language ?? 'en-US';
  const sayAttr = sayOpeningAttrs(lang);
  const lines: string[] = [];
  if (play.length > 0) lines.push(`  <Play>${escapeXml(play)}</Play>`);
  if (!options.blockTwilioSay && say.length > 0) lines.push(`  <Say${sayAttr}>${escapeXml(say)}</Say>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${lines.join('\n')}
  <Hangup />
</Response>`;
}

/**
 * Escape text node content for TwiML body elements.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escape attribute values (URLs, timeouts, language codes).
 */
export function escapeXmlAttribute(value: string): string {
  return escapeXml(value);
}
