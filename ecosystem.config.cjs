/**
 * PM2 — Twilio ConversationRelay voice agent (production).
 *
 * Start:
 *   cd /var/www/voice-agent
 *   cd services/twilio-voice-agent && python -m venv .venv && .venv/bin/pip install -r requirements.txt
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Nginx must proxy:
 *   POST /voice/twilio/inbound  → http://127.0.0.1:8001
 *   GET  /voice/twilio/ws       → http://127.0.0.1:8001  (upgrade: websocket)
 *   GET  /health                → http://127.0.0.1:8001
 */
const path = require('path');

const root = __dirname;
const twilioVoiceDir = path.join(root, 'services', 'twilio-voice-agent');

module.exports = {
  apps: [
    {
      name: 'twilio-voice-agent',
      cwd: twilioVoiceDir,
      script: path.join(twilioVoiceDir, '.venv', 'bin', 'uvicorn'),
      args: 'app.main:app --host 0.0.0.0 --port 8001 --workers 1',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        PYTHONPATH: twilioVoiceDir,
      },
    },
  ],
};
