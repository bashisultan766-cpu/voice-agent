/**
 * Node.js example — live 3CX caller lookup via voice-agent API.
 *
 * Prerequisites (.env on API server):
 *   THREE_CX_BASE_URL=https://your-pbx.3cx.us:5001
 *   THREE_CX_CLIENT_ID=...
 *   THREE_CX_CLIENT_SECRET=...
 *
 * Usage:
 *   API_BASE=https://agent.mailcallcommunication.com \
 *   VOICE_API_KEY=your-key \
 *   node examples/3cx/get-caller-info.example.mjs +12515551234
 */

const API_BASE = (process.env.API_BASE || 'http://localhost:3001').replace(/\/$/, '');
const VOICE_API_KEY = process.env.VOICE_API_KEY || '';
const phone = process.argv[2] || '+12515551234';

async function getCallerInfo(phoneNumber) {
  const res = await fetch(`${API_BASE}/api/voice/get-caller-info`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(VOICE_API_KEY ? { 'x-voice-api-key': VOICE_API_KEY } : {}),
    },
    body: JSON.stringify({ phone_number: phoneNumber }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

async function saveCallerName(phoneNumber, name) {
  const res = await fetch(`${API_BASE}/api/voice/save-caller-name`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(VOICE_API_KEY ? { 'x-voice-api-key': VOICE_API_KEY } : {}),
    },
    body: JSON.stringify({
      name,
      phoneNumber,
      callSid: 'EXAMPLE_CALL_SID',
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

const info = await getCallerInfo(phone);
console.log(JSON.stringify(info, null, 2));

if (info.should_ask_for_name) {
  console.log('\nUnknown caller — example save:');
  const saved = await saveCallerName(phone, 'Alex Johnson');
  console.log(JSON.stringify(saved, null, 2));
}
