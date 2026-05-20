"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactPaymentLikePatterns = redactPaymentLikePatterns;
function redactPaymentLikePatterns(text) {
    if (!text?.trim())
        return text;
    let out = text;
    out = out.replace(/\b(?:\d[ \-]*?){13,19}\b/g, '[payment detail removed]');
    out = out.replace(/\bcvv\b[\s:]*\d{3,4}\b/gi, 'cvv [removed]');
    out = out.replace(/\bcvc\b[\s:]*\d{3,4}\b/gi, 'cvc [removed]');
    out = out.replace(/\bsecurity code\b[\s:]*\d{3,4}\b/gi, 'security code [removed]');
    return out;
}
//# sourceMappingURL=redact-voice-input.js.map