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
      name: 'voice-web',
      cwd: __dirname,
      script: 'node_modules/.bin/tsx',
      args: 'server.ts',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: '3005',
        HOSTNAME: '0.0.0.0',
      },
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
