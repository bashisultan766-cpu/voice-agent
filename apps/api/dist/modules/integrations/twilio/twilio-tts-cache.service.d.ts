export declare class TwilioTtsCacheService {
    private readonly cache;
    private readonly ttlMs;
    put(data: Buffer): string;
    take(token: string): Buffer | null;
    private pruneExpired;
}
