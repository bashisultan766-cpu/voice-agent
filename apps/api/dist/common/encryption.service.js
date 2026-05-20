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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncryptionService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto = require("crypto");
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const VERSION = 'v1';
let EncryptionService = class EncryptionService {
    constructor(config) {
        this.config = config;
        this.key = null;
        const raw = this.config?.get('ENCRYPTION_KEY') ?? process.env.ENCRYPTION_KEY;
        if (raw) {
            const buf = Buffer.from(raw, 'hex');
            if (buf.length === KEY_LENGTH)
                this.key = buf;
        }
    }
    isAvailable() {
        return this.key !== null;
    }
    encrypt(plaintext) {
        if (!this.key)
            return null;
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_LENGTH });
        const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
            version: VERSION,
            iv: iv.toString('base64url'),
            tag: tag.toString('base64url'),
            ciphertext: enc.toString('base64url'),
        };
    }
    decrypt(payload) {
        if (!this.key || payload.version !== VERSION)
            return null;
        try {
            const iv = Buffer.from(payload.iv, 'base64url');
            const tag = Buffer.from(payload.tag, 'base64url');
            const ciphertext = Buffer.from(payload.ciphertext, 'base64url');
            const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_LENGTH });
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        }
        catch {
            return null;
        }
    }
    encryptToStorage(plaintext) {
        const p = this.encrypt(plaintext);
        if (!p)
            return null;
        return [p.version, p.iv, p.tag, p.ciphertext].join(':');
    }
    decryptFromStorage(stored) {
        const parts = stored.split(':');
        if (parts.length !== 4)
            return null;
        return this.decrypt({
            version: parts[0],
            iv: parts[1],
            tag: parts[2],
            ciphertext: parts[3],
        });
    }
};
exports.EncryptionService = EncryptionService;
exports.EncryptionService = EncryptionService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [config_1.ConfigService])
], EncryptionService);
//# sourceMappingURL=encryption.service.js.map