"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInboundGatherMvpTwiML = buildInboundGatherMvpTwiML;
exports.buildDeferredVoiceKickoffTwiML = buildDeferredVoiceKickoffTwiML;
exports.buildDeferredVoicePollPauseTwiML = buildDeferredVoicePollPauseTwiML;
exports.buildDeferredVoiceMomentPleaseTwiML = buildDeferredVoiceMomentPleaseTwiML;
exports.buildVoiceTerminalTwiml = buildVoiceTerminalTwiml;
exports.escapeXml = escapeXml;
exports.escapeXmlAttribute = escapeXmlAttribute;
const TWILIO_SAY_VOICE_EN = 'Polly.Matthew';
function sayOpeningAttrs(language) {
    const lang = (language || 'en-US').trim();
    if (lang.toLowerCase().startsWith('en')) {
        return ` voice="${escapeXmlAttribute(TWILIO_SAY_VOICE_EN)}" language="${escapeXmlAttribute(lang)}"`;
    }
    return ` language="${escapeXmlAttribute(lang)}"`;
}
function buildInboundGatherMvpTwiML(options) {
    const language = options.language ?? 'en-US';
    const speechTimeout = options.speechTimeout ?? 'auto';
    const timeoutSeconds = Number.isFinite(options.timeoutSeconds) ? Math.max(2, Math.trunc(options.timeoutSeconds)) : 5;
    const pauseRaw = options.pauseBeforeListenSeconds;
    const pauseBeforeListen = pauseRaw === undefined ? 1 : Math.max(0, Math.min(10, Math.trunc(Number(pauseRaw))));
    const includePromptInsideGather = options.includePromptInsideGather === true;
    const actionAttr = escapeXmlAttribute(options.gatherActionUrl);
    const playbackAudioUrl = options.playbackAudioUrl?.trim() ?? '';
    const finalFallbackAudioUrl = options.finalFallbackAudioUrl?.trim() ?? '';
    const blockTwilioSay = options.blockTwilioSay === true;
    const openingSayText = blockTwilioSay ? '' : (options.openingSayText?.trim() ?? '');
    const finalFallbackSayText = blockTwilioSay ? '' : (options.finalFallbackSayText?.trim() ?? '');
    const sayAttr = sayOpeningAttrs(language);
    const gatherInnerLines = [];
    if (includePromptInsideGather) {
        if (playbackAudioUrl.length > 0)
            gatherInnerLines.push(`    <Play>${escapeXml(playbackAudioUrl)}</Play>`);
        if (!blockTwilioSay && openingSayText.length > 0)
            gatherInnerLines.push(`    <Say${sayAttr}>${escapeXml(openingSayText)}</Say>`);
        if (pauseBeforeListen > 0) {
            gatherInnerLines.push(`    <Pause length="${pauseBeforeListen}"/>`);
        }
    }
    const gatherInner = gatherInnerLines.length > 0 ? `${gatherInnerLines.join('\n')}\n` : '';
    const preGatherLines = [];
    if (!includePromptInsideGather) {
        if (playbackAudioUrl.length > 0)
            preGatherLines.push(`  <Play>${escapeXml(playbackAudioUrl)}</Play>`);
        else if (!blockTwilioSay && openingSayText.length > 0)
            preGatherLines.push(`  <Say${sayAttr}>${escapeXml(openingSayText)}</Say>`);
    }
    const preGather = preGatherLines.length > 0 ? `${preGatherLines.join('\n')}\n` : '';
    const afterGatherLines = [];
    if (finalFallbackAudioUrl.length > 0)
        afterGatherLines.push(`  <Play>${escapeXml(finalFallbackAudioUrl)}</Play>`);
    if (!blockTwilioSay && finalFallbackSayText.length > 0)
        afterGatherLines.push(`  <Say${sayAttr}>${escapeXml(finalFallbackSayText)}</Say>`);
    const afterGather = afterGatherLines.length > 0 ? `${afterGatherLines.join('\n')}\n` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${preGather}  <Gather input="speech" action="${actionAttr}" method="POST" speechTimeout="${escapeXmlAttribute(speechTimeout)}" timeout="${timeoutSeconds}" language="${escapeXmlAttribute(language)}" actionOnEmptyResult="true">
${gatherInner}  </Gather>
${afterGather}  <Hangup />
</Response>`;
}
function buildDeferredVoiceKickoffTwiML(options) {
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
function buildDeferredVoicePollPauseTwiML(options) {
    const pauseRaw = options.pauseSeconds;
    const pause = pauseRaw === undefined ? 1 : Math.max(1, Math.min(5, Math.trunc(Number(pauseRaw))));
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="${pause}"/>
  <Redirect method="POST">${escapeXmlAttribute(options.deferPollUrl)}</Redirect>
</Response>`;
}
function buildDeferredVoiceMomentPleaseTwiML(options) {
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
function buildVoiceTerminalTwiml(options) {
    const play = options.playbackAudioUrl?.trim() ?? '';
    const say = options.blockTwilioSay ? '' : (options.sayText?.trim() ?? '');
    const lang = options.language ?? 'en-US';
    const sayAttr = sayOpeningAttrs(lang);
    const lines = [];
    if (play.length > 0)
        lines.push(`  <Play>${escapeXml(play)}</Play>`);
    if (!options.blockTwilioSay && say.length > 0)
        lines.push(`  <Say${sayAttr}>${escapeXml(say)}</Say>`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${lines.join('\n')}
  <Hangup />
</Response>`;
}
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function escapeXmlAttribute(value) {
    return escapeXml(value);
}
//# sourceMappingURL=gather-mvp.twiml.js.map