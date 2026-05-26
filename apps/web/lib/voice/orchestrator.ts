import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { StoreSetting } from '@bookstore-voice-agents/voice-db';
import {
  isLegacyWebVoicePathAllowed,
  LEGACY_WEB_VOICE_PRODUCTION_BLOCK_MESSAGE,
} from '@bookstore-voice-agents/types';
import { getVoicePrisma } from './prisma';
import { chunkTextForRelay } from './chunk-text';

export type VoiceSendText = (token: string, last: boolean) => void;

async function appendCallTranscript(callLogId: string, line: string): Promise<void> {
  const prisma = getVoicePrisma();
  const row = await prisma.callLog.findUnique({ where: { id: callLogId }, select: { transcript: true } });
  const prev = row?.transcript ?? '';
  await prisma.callLog.update({
    where: { id: callLogId },
    data: { transcript: prev ? `${prev}\n${line}` : line },
  });
}

/**
 * @param conversationalMessages must NOT include a system message. It should include the latest user turn.
 * @returns updated conversational messages to persist for the next turn (still no system message).
 */
export async function runVoiceAssistantTurn(params: {
  storeKey: string;
  settings: StoreSetting;
  callLogId: string;
  conversationalMessages: ChatCompletionMessageParam[];
  sendText: VoiceSendText;
}): Promise<ChatCompletionMessageParam[]> {
  if (!isLegacyWebVoicePathAllowed(process.env.NODE_ENV)) {
    for (const chunk of chunkTextForRelay(LEGACY_WEB_VOICE_PRODUCTION_BLOCK_MESSAGE)) {
      params.sendText(chunk, false);
    }
    params.sendText('', true);
    return params.conversationalMessages;
  }

  const lastUser = [...params.conversationalMessages].reverse().find((m) => m.role === 'user');
  const userText =
    typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
  await appendCallTranscript(params.callLogId, `[user]: ${userText}`);

  /**
   * Legacy web voice DB (StoreSetting) does not store OpenAI keys.
   * Use the Nest agent runtime and per-agent credentials in the main dashboard instead.
   */
  for (const chunk of chunkTextForRelay(
    'This legacy web voice path does not load OpenAI from environment variables. Configure OpenAI on your agent in the dashboard.',
  )) {
    params.sendText(chunk, false);
  }
  params.sendText('', true);
  return params.conversationalMessages;
}
