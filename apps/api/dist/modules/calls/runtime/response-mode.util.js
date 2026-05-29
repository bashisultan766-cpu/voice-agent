"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideResponseMode = decideResponseMode;
function decideResponseMode(args) {
    void args.intent;
    void args.customerText;
    const ve = args.toolResult?.validateEmail;
    if (ve != null &&
        ve.valid === false &&
        (args.state === 'EMAIL_COLLECTING' || args.state === 'EMAIL_CONFIRMING' || args.state === 'EMAIL_COLLECTION')) {
        return 'template';
    }
    return 'openai';
}
//# sourceMappingURL=response-mode.util.js.map