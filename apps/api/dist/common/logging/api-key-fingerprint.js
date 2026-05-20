"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fingerprintApiKey = fingerprintApiKey;
function fingerprintApiKey(key) {
    const t = key?.trim();
    if (!t)
        return null;
    if (t.length <= 12)
        return `${t.slice(0, 4)}…${t.slice(-2)}`;
    return `${t.slice(0, 8)}…${t.slice(-4)}`;
}
//# sourceMappingURL=api-key-fingerprint.js.map