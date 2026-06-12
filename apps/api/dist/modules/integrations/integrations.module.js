"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationsModule = void 0;
const common_1 = require("@nestjs/common");
const twilio_module_1 = require("./twilio/twilio.module");
const elevenlabs_module_1 = require("./elevenlabs/elevenlabs.module");
const shopify_module_1 = require("./shopify/shopify.module");
const email_module_1 = require("./email/email.module");
const caller_identity_module_1 = require("./caller-identity/caller-identity.module");
let IntegrationsModule = class IntegrationsModule {
};
exports.IntegrationsModule = IntegrationsModule;
exports.IntegrationsModule = IntegrationsModule = __decorate([
    (0, common_1.Module)({
        imports: [twilio_module_1.TwilioModule, elevenlabs_module_1.ElevenLabsModule, shopify_module_1.ShopifyModule, email_module_1.EmailModule, caller_identity_module_1.CallerIdentityModule],
    })
], IntegrationsModule);
//# sourceMappingURL=integrations.module.js.map