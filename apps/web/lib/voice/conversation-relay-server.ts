import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { VoiceCallStatus } from '@bookstore-voice-agents/voice-db';
import { isLegacyWebVoicePathAllowed } from '@bookstore-voice-agents/types';
import { getPublicWebSocketUrlFromRequest, validateTwilioWebSocketRequest } from '@/lib/twilio/signature';
import { VOICE_WS_PATH } from '@/lib/voice/constants';
import { FALLBACK_SPEECH } from '@/lib/voice/constants';
import { getVoicePrisma } from '@/lib/voice/prisma';
import { isPrismaUniqueViolation } from '@/lib/voice/prisma-errors';
import { runVoiceAssistantTurn } from '@/lib/voice/orchestrator';
import { chunkTextForRelay } from '@/lib/voice/chunk-text';

type RelaySetup = {
  type: 'setup';
  sessionId: string;
  callSid: string;
  from?: string;
  to?: string;
  customParameters?: Record<string, string>;
};

type RelayPrompt = { type: 'prompt'; voicePrompt: string; lang?: string; last?: boolean };

function safeSend(ws: WebSocket, payload: unknown) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function sendRelayText(ws: WebSocket, token: string, last: boolean) {
  safeSend(ws, { type: 'text', token, last, interruptible: false, preemptible: false });
}

async function resolveStoreKey(toNumber?: string): Promise<string | null> {
  const prisma = getVoicePrisma();
  const to = toNumber?.trim();
  if (to) {
    const hit = await prisma.storeSetting.findUnique({ where: { storeKey: to } });
    if (hit) return hit.storeKey;
  }

  const def = process.env.VOICE_DEFAULT_STORE_KEY?.trim();
  if (def) {
    const hit = await prisma.storeSetting.findUnique({ where: { storeKey: def } });
    if (hit) return hit.storeKey;
  }

  return null;
}

async function sendFallbackAndOptionalEnd(ws: WebSocket, end: boolean) {
  for (const chunk of chunkTextForRelay(FALLBACK_SPEECH)) {
    sendRelayText(ws, chunk, false);
  }
  sendRelayText(ws, '', true);
  if (end) {
    safeSend(ws, {
      type: 'end',
      handoffData: JSON.stringify({ reasonCode: 'error', reason: 'Assistant fallback' }),
    });
  }
}

export async function handleConversationRelayConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  if (!isLegacyWebVoicePathAllowed(process.env.NODE_ENV)) {
    ws.close(1008, 'Legacy web voice path disabled in production');
    return;
  }

  const publicWsUrl = getPublicWebSocketUrlFromRequest(req, VOICE_WS_PATH);
  const sig = req.headers['x-twilio-signature'];
  const ok = validateTwilioWebSocketRequest({
    signature: typeof sig === 'string' ? sig : Array.isArray(sig) ? sig[0] : undefined,
    publicWsUrl,
  });

  if (!ok) {
    ws.close(1008, 'Invalid Twilio signature');
    return;
  }

  const prisma = getVoicePrisma();
  let storeKey: string | null = null;
  let callLogId: string | null = null;
  let settingsLoaded = false;

  let promptBuffer = '';
  let conversationalMessages: ChatCompletionMessageParam[] = [];
  let processing = false;

  ws.on('message', (raw) => {
    void (async () => {
      if (processing) return;
      try {
        const parsed = JSON.parse(String(raw)) as { type?: string } & Record<string, unknown>;
        const t = parsed.type;

        if (t === 'setup') {
          const s = parsed as unknown as RelaySetup;
          storeKey = await resolveStoreKey(s.to);
          if (!storeKey) {
            await sendFallbackAndOptionalEnd(ws, false);
            return;
          }

          const settings = await prisma.storeSetting.findUnique({ where: { storeKey } });
          if (!settings) {
            await sendFallbackAndOptionalEnd(ws, false);
            return;
          }
          settingsLoaded = true;

          try {
            const log = await prisma.callLog.create({
              data: {
                storeKey,
                twilioCallSid: s.callSid,
                twilioSessionId: s.sessionId,
                fromNumber: s.from,
                toNumber: s.to,
              },
            });
            callLogId = log.id;
          } catch (err) {
            if (isPrismaUniqueViolation(err) && s.callSid) {
              const existing = await prisma.callLog.findUnique({
                where: { twilioCallSid: s.callSid },
                select: { id: true },
              });
              if (existing) callLogId = existing.id;
            } else {
              throw err;
            }
          }
          return;
        }

        if (t === 'prompt') {
          if (!settingsLoaded || !storeKey || !callLogId) return;

          const p = parsed as unknown as RelayPrompt;
          const piece = (p.voicePrompt ?? '').toString();
          const isLast = p.last !== false; // default true if omitted
          promptBuffer += piece;

          if (!isLast) return;

          const userText = promptBuffer.trim();
          promptBuffer = '';
          if (!userText) return;

          processing = true;
          const settings = await prisma.storeSetting.findUnique({ where: { storeKey } });
          if (!settings) {
            await sendFallbackAndOptionalEnd(ws, false);
            processing = false;
            return;
          }

          conversationalMessages.push({ role: 'user', content: userText });

          try {
            conversationalMessages = await runVoiceAssistantTurn({
              storeKey,
              settings,
              callLogId,
              conversationalMessages,
              sendText: (token, last) => sendRelayText(ws, token, last),
            });
          } catch {
            await sendFallbackAndOptionalEnd(ws, false);
          } finally {
            processing = false;
          }
          return;
        }

        if (t === 'error') {
          const desc = typeof parsed.description === 'string' ? parsed.description : 'Unknown relay error';
          if (callLogId) {
            await prisma.callLog.update({
              where: { id: callLogId },
              data: { errorMessage: desc.slice(0, 2000) },
            });
          }
        }
      } catch {
        // ignore malformed inbound frames
      }
    })();
  });

  ws.on('close', () => {
    void (async () => {
      if (!callLogId) return;
      try {
        await prisma.callLog.update({
          where: { id: callLogId },
          data: { endedAt: new Date(), status: VoiceCallStatus.COMPLETED },
        });
      } catch {
        // ignore
      }
    })();
  });

  ws.on('error', () => {
    void (async () => {
      if (!callLogId) return;
      try {
        await prisma.callLog.update({
          where: { id: callLogId },
          data: { endedAt: new Date(), status: VoiceCallStatus.FAILED },
        });
      } catch {
        // ignore
      }
    })();
  });
}
