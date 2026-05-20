type VoicePrismaClient = any;

const globalForPrisma = globalThis as unknown as { voicePrisma?: VoicePrismaClient };

export function getVoicePrisma(): VoicePrismaClient {
  if (!globalForPrisma.voicePrisma) {
    // Lazy-load voice-db Prisma only when a route actually needs it.
    const { PrismaClient } = require('@bookstore-voice-agents/voice-db') as {
      PrismaClient: new (args: { log: Array<'error' | 'warn'> }) => VoicePrismaClient;
    };
    globalForPrisma.voicePrisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
  }
  return globalForPrisma.voicePrisma;
}
