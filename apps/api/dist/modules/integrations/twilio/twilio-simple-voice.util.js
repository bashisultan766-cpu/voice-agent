"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeXmlText = escapeXmlText;
exports.escapeXmlAttr = escapeXmlAttr;
exports.buildFastInboundTwiml = buildFastInboundTwiml;
exports.buildGatherNoSpeechTwiml = buildGatherNoSpeechTwiml;
exports.buildGatherAiReplyTwiml = buildGatherAiReplyTwiml;
exports.buildGatherErrorTwiml = buildGatherErrorTwiml;
function escapeXmlText(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function escapeXmlAttr(value) {
    return escapeXmlText(value);
}
function buildFastInboundTwiml(gatherActionAbsoluteUrl) {
    const action = escapeXmlAttr(gatherActionAbsoluteUrl);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" speechTimeout="auto">
    <Say>Hello! Welcome to our store. How can I help you today?</Say>
  </Gather>
</Response>`;
}
function buildGatherNoSpeechTwiml(inboundAbsoluteUrl) {
    const url = escapeXmlAttr(inboundAbsoluteUrl);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>I did not hear you. Please say again.</Say>
  <Redirect method="POST">${url}</Redirect>
</Response>`;
}
function buildGatherAiReplyTwiml(reply, inboundAbsoluteUrl) {
    const said = escapeXmlText(reply);
    const url = escapeXmlAttr(inboundAbsoluteUrl);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${said}</Say>
  <Redirect method="POST">${url}</Redirect>
</Response>`;
}
function buildGatherErrorTwiml(message, inboundAbsoluteUrl) {
    return buildGatherAiReplyTwiml(message, inboundAbsoluteUrl);
}
//# sourceMappingURL=twilio-simple-voice.util.js.map