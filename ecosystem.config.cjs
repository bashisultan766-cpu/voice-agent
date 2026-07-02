/**
 * PM2 — SureShot Books multi-service voice stack.
 *
 * Twilio webhook stays at the original project URL:
 *   POST /voice/twilio/inbound  → voice-router :8000 (nginx)
 *   POST /voice/twilio/agent/inbound → twilio-voice-agent :8001 (internal)
 */
const path = require('path');

const root = __dirname;
const twilioVoiceDir = path.join(root, 'services', 'twilio-voice-agent');
const orderLookupDir = path.join(root, 'services', 'order-lookup-voice-agent');
const voiceRouterDir = path.join(root, 'services', 'voice-router');

module.exports = {
  apps: [
    {
      name: 'voice-router',
      cwd: voiceRouterDir,
      script: 'node',
      args: 'dist/index.js',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
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
