/**
 * PM2 config for the Next.js custom server (WebSocket + App Router).
 *
 * On VPS:
 *   cd /var/www/voice-agent/apps/web
 *   pnpm build
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'voice-agent-web',
      cwd: __dirname,
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
      env_file: '.env.local',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      listen_timeout: 30_000,
      kill_timeout: 10_000,
      merge_logs: true,
      time: true,
    },
  ],
};
