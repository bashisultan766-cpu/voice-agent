"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeProductFollowUpKey = normalizeProductFollowUpKey;
function normalizeProductFollowUpKey(title) {
    return title
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, 160);
}
//# sourceMappingURL=product-follow-up.util.js.map