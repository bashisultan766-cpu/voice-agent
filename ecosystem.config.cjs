/**
 * PM2 — canonical production config (run from repo root).
 *
 *   cd /var/www/voice-agent
 *   pnpm --filter api build && pnpm --filter web build
 *   pm2 delete voice-api voice-web voice-agent-api voice-agent-web 2>/dev/null || true
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * IMPORTANT: Run only ONE API process. Do not also start infra/ecosystem.config.cjs
 * (that uses names voice-api / voice-web) unless you delete these first.
 *
 * API loads apps/api/.env via Nest (cwd must be apps/api).
 */
const path = require('path');

const root = __dirname;
const apiDir = path.join(root, 'apps', 'api');
const webDir = path.join(root, 'apps', 'web');

module.exports = {
  apps: [
    {
      name: 'voice-api',
      cwd: apiDir,
      script: 'dist/main.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
    {
      name: 'voice-web',
      cwd: webDir,
      script: path.join(webDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      args: '--tsconfig tsconfig.json -r tsconfig-paths/register server.ts',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
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
