"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideResponseMode = decideResponseMode;
function decideResponseMode(args) {
    void args.intent;
    void args.state;
    void args.customerText;
    const sp = args.toolResult?.searchProducts;
    const ve = args.toolResult?.validateEmail;
    const pay = args.toolResult?.sendPaymentEmail;
    if (pay != null)
        return 'template';
    if (ve != null && ve.valid === false)
        return 'template';
    if (sp?.ok === false && sp.errorCode === 'SHOPIFY_SEARCH_FAILED')
        return 'template';
    if (sp?.ok === true && sp.found === true && !sp.requiresClarification && sp.title?.trim()) {
        return 'template';
    }
    return 'openai';
}
//# sourceMappingURL=response-mode.util.js.map