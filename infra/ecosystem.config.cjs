/**
 * PM2 — production voice agent (VPS).
 *
 * CRITICAL:
 * - voice-agent-api MUST run compiled JS: `node dist/main.js` (never tsx on src/*.ts).
 *   tsx breaks Nest DI (ConfigService undefined → crash loop).
 * - voice-agent-web uses tsx + tsconfig-paths for @/ path aliases on server.ts.
 *
 * Deploy:
 *   cd /var/www/voice-agent
 *   pnpm install && pnpm db:generate:all
 *   pnpm --filter api build && pnpm --filter web build
 *   pm2 delete voice-agent-api voice-agent-web 2>/dev/null; pm2 start infra/ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'voice-agent-api',
      cwd: './apps/api',
      script: 'dist/main.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
    {
      name: 'voice-agent-web',
      cwd: './apps/web',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: '--tsconfig tsconfig.json -r tsconfig-paths/register server.ts',
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
      },
    },
  ],
};
