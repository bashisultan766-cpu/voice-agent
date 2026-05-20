"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioTtsCacheService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
let TwilioTtsCacheService = class TwilioTtsCacheService {
    constructor() {
        this.cache = new Map();
        this.ttlMs = 5 * 60 * 1000;
    }
    put(data) {
        this.pruneExpired();
        const token = (0, crypto_1.randomBytes)(24).toString('hex');
        this.cache.set(token, {
            data,
            expiresAt: Date.now() + this.ttlMs,
        });
        return token;
    }
    take(token) {
        const entry = this.cache.get(token);
        if (!entry)
            return null;
        this.cache.delete(token);
        if (entry.expiresAt <= Date.now())
            return null;
        return entry.data;
    }
    pruneExpired() {
        const now = Date.now();
        for (const [token, entry] of this.cache.entries()) {
            if (entry.expiresAt <= now) {
                this.cache.delete(token);
            }
        }
    }
};
exports.TwilioTtsCacheService = TwilioTtsCacheService;
exports.TwilioTtsCacheService = TwilioTtsCacheService = __decorate([
    (0, common_1.Injectable)()
], TwilioTtsCacheService);
//# sourceMappingURL=twilio-tts-cache.service.js.map