/**
 * PM2 process definitions for VPS deployment.
 * Usage (from repo root):
 *   pnpm --filter api build && pnpm --filter web build
 *   pm2 start infra/ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'voice-api',
      cwd: './apps/api',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
    {
      name: 'voice-web',
      cwd: './apps/web',
      // tsx + tsconfig-paths: resolves @/lib/* outside Next bundler (ConversationRelay WS).
      script: 'node_modules/tsx/dist/cli.mjs',
      args: '--tsconfig tsconfig.json -r tsconfig-paths/register server.ts',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
      },
    },
  ],
};
