/**
 * PM2 — Twilio ConversationRelay voice agent (production).
 *
 * Start:
 *   cd /var/www/voice-agent
 *   cd services/twilio-voice-agent && python -m venv .venv && .venv/bin/pip install -r requirements.txt
 *   APP_ENV=production python scripts/pre_deploy_health_gate.py
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   python -m app.scripts.runtime_identity_check   # must PASS before taking calls
 *   curl -sS http://127.0.0.1:8001/health | jq .runtime_identity_ok
 *
 * Graceful reload (zero-downtime for new HTTP; active WS calls drain on old process):
 *   pm2 reload twilio-voice-agent --update-env
 *
 * Rollback:
 *   git checkout <previous-tag> && .venv/bin/pip install -r requirements.txt
 *   pm2 reload twilio-voice-agent --update-env
 *
 * Log rotation (install once):
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:max_size 50M
 *   pm2 set pm2-logrotate:retain 14
 *
 * Nginx must proxy:
 *   POST /voice/twilio/inbound  → http://127.0.0.1:8001
 *   GET  /voice/twilio/ws       → http://127.0.0.1:8001  (upgrade: websocket)
 *   GET  /health                → http://127.0.0.1:8001
 *
 * Multi-worker: keep instances=1 and uvicorn --workers 1 (see docs/MULTI_WORKER_SAFETY_AUDIT.md).
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
      max_memory_restart: '512M',
      kill_timeout: 15000,
      listen_timeout: 10000,
      env: {
        PYTHONPATH: twilioVoiceDir,
        APP_ENV: 'production',
      },
    },
  ],
};
