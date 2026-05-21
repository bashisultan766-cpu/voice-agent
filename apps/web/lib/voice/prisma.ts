import type { PrismaClient } from '@bookstore-voice-agents/voice-db';

const globalForPrisma = globalThis as unknown as { voicePrisma?: PrismaClient };

export function getVoicePrisma(): PrismaClient {
  if (!globalForPrisma.voicePrisma) {
    // Lazy-load voice-db Prisma only on server routes that need it.
    const { PrismaClient } = require('@bookstore-voice-agents/voice-db') as {
      PrismaClient: typeof import('@bookstore-voice-agents/voice-db').PrismaClient;
    };
    globalForPrisma.voicePrisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
  }
  return globalForPrisma.voicePrisma;
}
