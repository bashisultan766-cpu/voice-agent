import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const VERSION = 'v1';

export interface EncryptedPayload {
  version: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

@Injectable()
export class EncryptionService {
  private key: Buffer | null = null;

  constructor(@Optional() private readonly config?: ConfigService) {
    const raw = this.config?.get<string>('ENCRYPTION_KEY') ?? process.env.ENCRYPTION_KEY;
    if (raw) {
      const buf = Buffer.from(raw, 'hex');
      if (buf.length === KEY_LENGTH) this.key = buf;
    }
  }

  isAvailable(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): EncryptedPayload | null {
    if (!this.key) return null;
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

  decrypt(payload: EncryptedPayload): string | null {
    if (!this.key || payload.version !== VERSION) return null;
    try {
      const iv = Buffer.from(payload.iv, 'base64url');
      const tag = Buffer.from(payload.tag, 'base64url');
      const ciphertext = Buffer.from(payload.ciphertext, 'base64url');
      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Encrypt to a single string (version:iv:tag:ciphertext) for DB storage. */
  encryptToStorage(plaintext: string): string | null {
    const p = this.encrypt(plaintext);
    if (!p) return null;
    return [p.version, p.iv, p.tag, p.ciphertext].join(':');
  }

  /** Decrypt from storage string. */
  decryptFromStorage(stored: string): string | null {
    const parts = stored.split(':');
    if (parts.length !== 4) return null;
    return this.decrypt({
      version: parts[0],
      iv: parts[1],
      tag: parts[2],
      ciphertext: parts[3],
    });
  }
}
