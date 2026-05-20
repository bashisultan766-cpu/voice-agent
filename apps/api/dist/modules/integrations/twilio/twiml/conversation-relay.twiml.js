"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildConversationRelayTwiML = buildConversationRelayTwiML;
exports.buildFallbackTwiML = buildFallbackTwiML;
function buildConversationRelayTwiML(websocketUrl) {
    const encoded = encodeURIComponent(websocketUrl);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${encoded}" />
  </Connect>
</Response>`;
}
function buildFallbackTwiML(message) {
    const say = message ?? "We're sorry, this line is not configured. Please try again later.";
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew" language="en-US">${escapeXml(say)}</Say>
  <Hangup />
</Response>`;
}
function escapeXml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
//# sourceMappingURL=conversation-relay.twiml.js.map