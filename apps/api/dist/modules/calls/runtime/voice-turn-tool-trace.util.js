"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyVoiceToolTrace = applyVoiceToolTrace;
function applyVoiceToolTrace(trace, toolName, toolArgs, result) {
    switch (toolName) {
        case 'searchProducts':
            if (result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
                const d = result.data;
                const results = Array.isArray(d.results) ? d.results : [];
                const top = results[0];
                const variants = Array.isArray(top?.variants) ? top.variants : [];
                const v0 = variants[0];
                trace.searchProducts = {
                    ok: true,
                    found: results.length > 0,
                    title: typeof top?.title === 'string' ? top.title : undefined,
                    price: typeof v0?.price === 'string' ? v0.price : null,
                    requiresClarification: d.requiresClarification === true,
                };
            }
            else {
                const err = result.error && typeof result.error === 'object' ? result.error : null;
                trace.searchProducts = {
                    ok: false,
                    found: false,
                    requiresClarification: false,
                    errorCode: typeof err?.code === 'string' ? err.code : undefined,
                };
            }
            break;
        case 'validateEmail':
            if (result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
                const d = result.data;
                trace.validateEmail = {
                    valid: d.valid === true,
                    email: typeof d.normalizedEmail === 'string' ? d.normalizedEmail : null,
                };
            }
            break;
        case 'sendPaymentEmail': {
            const emailArg = typeof toolArgs.email === 'string' ? toolArgs.email.trim() : '';
            if (result.ok && result.data && typeof result.data === 'object') {
                const d = result.data;
                trace.sendPaymentEmail = {
                    ok: true,
                    deduplicated: d.deduplicated === true,
                    email: emailArg || undefined,
                };
            }
            else {
                trace.sendPaymentEmail = {
                    ok: false,
                    email: emailArg || undefined,
                };
            }
            break;
        }
        default:
            break;
    }
}
//# sourceMappingURL=voice-turn-tool-trace.util.js.map