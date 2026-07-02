/**
 * PM2 — SureShot Books order lookup voice agent (production).
 *
 * Twilio number (+12512554549) webhook:
 *   POST /voice/twilio/inbound  → order-lookup-voice-agent :8001
 *   GET  /voice/twilio/ws       → order-lookup-voice-agent :8001
 *
 * Legacy Python commerce agent (services/twilio-voice-agent) is NOT started in production.
 */
const path = require('path');

const root = __dirname;
const orderLookupDir = path.join(root, 'services', 'order-lookup-voice-agent');

module.exports = {
  apps: [
    {
      name: 'order-lookup-voice-agent',
      cwd: orderLookupDir,
      script: 'node',
      args: 'dist/index.js',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
