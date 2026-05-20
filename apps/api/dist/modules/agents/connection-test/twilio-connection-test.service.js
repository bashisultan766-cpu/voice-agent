"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioConnectionTestService = void 0;
const common_1 = require("@nestjs/common");
const normalize_phone_1 = require("../../integrations/twilio/utils/normalize-phone");
let TwilioConnectionTestService = class TwilioConnectionTestService {
    authHeader(config) {
        const sid = config.twilioAccountSid.trim();
        const token = config.twilioAuthToken.trim();
        return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
    }
    apiBase(config) {
        return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid.trim())}`;
    }
    validateRequired(config) {
        const sid = config.twilioAccountSid?.trim();
        const token = config.twilioAuthToken?.trim();
        if (!sid)
            return 'Twilio Account SID is required to test the connection.';
        if (!token)
            return 'Twilio Auth Token is required to test the connection.';
        return null;
    }
    async testConnection(config) {
        const validationError = this.validateRequired(config);
        if (validationError) {
            return { success: false, message: validationError };
        }
        const sid = config.twilioAccountSid.trim();
        const token = config.twilioAuthToken.trim();
        const auth = Buffer.from(`${sid}:${token}`).toString('base64');
        const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`;
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            if (!res.ok) {
                const text = await res.text();
                return { success: false, message: `Twilio API returned ${res.status}: ${text.slice(0, 150)}` };
            }
            const data = (await res.json());
            const name = data.friendly_name ?? sid;
            return { success: true, message: `Connected to Twilio account: ${name}.` };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, message: `Twilio connection failed: ${message}` };
        }
    }
    async resolveIncomingPhoneSid(config) {
        const validationError = this.validateRequired(config);
        if (validationError)
            return null;
        const phoneRaw = config.twilioPhoneNumber?.trim();
        if (!phoneRaw)
            return null;
        const phone = (0, normalize_phone_1.normalizePhoneNumber)(phoneRaw);
        const sid = config.twilioAccountSid.trim();
        const token = config.twilioAuthToken.trim();
        const auth = Buffer.from(`${sid}:${token}`).toString('base64');
        const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json`;
        const url = `${base}?PhoneNumber=${encodeURIComponent(phone)}`;
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Basic ${auth}`,
                },
            });
            if (!res.ok)
                return null;
            const data = (await res.json());
            const first = data.incoming_phone_numbers?.[0];
            return first?.sid?.trim() || null;
        }
        catch {
            return null;
        }
    }
    async getIncomingPhoneNumberConfig(config) {
        const validationError = this.validateRequired(config);
        if (validationError)
            return null;
        const phoneRaw = config.twilioPhoneNumber?.trim();
        if (!phoneRaw)
            return null;
        const phone = (0, normalize_phone_1.normalizePhoneNumber)(phoneRaw);
        const url = `${this.apiBase(config)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`;
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: { Authorization: this.authHeader(config) },
            });
            if (!res.ok)
                return null;
            const data = (await res.json());
            const row = data.incoming_phone_numbers?.[0];
            if (!row?.sid || !row?.account_sid || !row?.phone_number)
                return null;
            return {
                sid: row.sid,
                accountSid: row.account_sid,
                phoneNumber: row.phone_number,
                voiceUrl: row.voice_url ?? null,
                voiceMethod: row.voice_method ?? null,
                statusCallback: row.status_callback ?? null,
                statusCallbackMethod: row.status_callback_method ?? null,
            };
        }
        catch {
            return null;
        }
    }
    async updateIncomingPhoneNumberWebhook(config, opts) {
        const validationError = this.validateRequired(config);
        if (validationError)
            return { success: false, message: validationError };
        const method = opts.method ?? 'POST';
        const url = `${this.apiBase(config)}/IncomingPhoneNumbers/${encodeURIComponent(opts.incomingPhoneSid)}.json`;
        const body = new URLSearchParams({
            VoiceUrl: opts.voiceUrl,
            VoiceMethod: method,
            StatusCallback: opts.statusCallback,
            StatusCallbackMethod: method,
        });
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: this.authHeader(config),
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });
            if (!res.ok) {
                const text = await res.text();
                return { success: false, message: `Twilio update failed ${res.status}: ${text.slice(0, 200)}` };
            }
            return { success: true, message: 'Twilio phone number webhook updated.' };
        }
        catch (err) {
            return {
                success: false,
                message: err instanceof Error ? err.message : 'Twilio update request failed.',
            };
        }
    }
};
exports.TwilioConnectionTestService = TwilioConnectionTestService;
exports.TwilioConnectionTestService = TwilioConnectionTestService = __decorate([
    (0, common_1.Injectable)()
], TwilioConnectionTestService);
//# sourceMappingURL=twilio-connection-test.service.js.map