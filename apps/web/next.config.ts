import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Avoid dev startup stalls by not transpiling the DB workspace package in the browser app.
  transpilePackages: ['@bookstore-voice-agents/types'],
};

export default nextConfig;
