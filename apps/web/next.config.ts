import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@bookstore-voice-agents/types'],
  // Keep Prisma / voice-db on the server bundle only (API routes + custom server).
  serverExternalPackages: ['@bookstore-voice-agents/voice-db', '@prisma/client', 'prisma'],
};

export default nextConfig;
