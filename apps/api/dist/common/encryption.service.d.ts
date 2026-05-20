import { ConfigService } from '@nestjs/config';
export interface EncryptedPayload {
    version: string;
    iv: string;
    tag: string;
    ciphertext: string;
}
export declare class EncryptionService {
    private readonly config?;
    private key;
    constructor(config?: ConfigService | undefined);
    isAvailable(): boolean;
    encrypt(plaintext: string): EncryptedPayload | null;
    decrypt(payload: EncryptedPayload): string | null;
    encryptToStorage(plaintext: string): string | null;
    decryptFromStorage(stored: string): string | null;
}
