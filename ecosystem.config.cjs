/**
 * PM2 — run from repo root on VPS:
 *
 *   cd /var/www/voice-agent
 *   pnpm install && ./scripts/vps-deploy.sh
 *   pm2 start ecosystem.config.cjs --update-env
 *   pm2 save
 *
 * Restart after env changes:
 *   pm2 restart voice-agent-api voice-agent-web --update-env
 */
const path = require('path');

const root = __dirname;
const apiDir = path.join(root, 'apps', 'api');
const webDir = path.join(root, 'apps', 'web');

module.exports = {
  apps: [
    {
      name: 'voice-agent-api',
      cwd: apiDir,
      script: 'dist/main.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
      env_file: path.join(apiDir, '.env'),
      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 5000,
      merge_logs: true,
      time: true,
    },
    {
      name: 'voice-agent-web',
      cwd: webDir,
      script: 'pnpm',
      args: 'start',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
      },
      env_file: path.join(webDir, '.env.local'),
      autorestart: true,
      max_restarts: 15,
      min_uptime: '10s',
      restart_delay: 5000,
      listen_timeout: 30_000,
      kill_timeout: 10_000,
      merge_logs: true,
      time: true,
    },
  ],
};
