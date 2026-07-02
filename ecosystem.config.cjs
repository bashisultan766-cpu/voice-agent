/**
 * PM2 — Twilio ConversationRelay voice agent (production).
 *
 * Twilio webhook:
 *   POST /voice/twilio/inbound  → twilio-voice-agent :8001
 *   GET  /voice/twilio/ws       → twilio-voice-agent :8001
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
