/** In-memory Redis stand-in for tests — never throws. */
export class MockRedisStore {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setex(key: string, _ttl: number, value: string): Promise<void> {
    this.store.set(key, value);
  }

  shouldFail = false;

  async getWithFailure(key: string): Promise<string | null> {
    if (this.shouldFail) return null;
    return this.get(key);
  }
}

export function createMockRedisClient(store: MockRedisStore) {
  return {
    status: 'ready' as const,
    get: async (key: string) => (store.shouldFail ? Promise.reject(new Error('redis_down')) : store.get(key)),
    setex: async (key: string, ttl: number, val: string) => {
      if (store.shouldFail) throw new Error('redis_down');
      await store.setex(key, ttl, val);
      return 'OK';
    },
  };
}
