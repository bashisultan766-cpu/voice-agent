"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioSmsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
let TwilioSmsService = class TwilioSmsService {
    constructor(config) {
        this.config = config;
    }
    async sendSms(params) {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Messages.json`;
        const body = new URLSearchParams({
            From: params.from,
            To: params.to,
            Body: params.body,
        });
        const auth = Buffer.from(`${params.accountSid}:${params.authToken}`).toString('base64');
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`Twilio SMS ${res.status}: ${text.slice(0, 200)}`);
        }
        try {
            const json = JSON.parse(text);
            return { sid: json.sid };
        }
        catch {
            return {};
        }
    }
    defaultMessagingFrom() {
        return this.config.get('TWILIO_MESSAGING_FROM')?.trim() || null;
    }
};
exports.TwilioSmsService = TwilioSmsService;
exports.TwilioSmsService = TwilioSmsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], TwilioSmsService);
//# sourceMappingURL=twilio-sms.service.js.map