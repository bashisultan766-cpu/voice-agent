import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { StoreSetting } from '@bookstore-voice-agents/voice-db';
import { getVoicePrisma } from './prisma';
import { buildSystemPrompt } from './prompts';
import { chunkTextForRelay } from './chunk-text';
import { toolBookCallback, toolGetOrderStatus, toolSearchFaq, type ToolContext } from './tools-impl';
import { FALLBACK_SPEECH } from './constants';

const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getOrderStatus',
      description:
        'Look up a Shopify order by order number/name and verify the caller phone matches the order phone. Never invent results.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['orderNumber', 'phone'],
        properties: {
          orderNumber: { type: 'string', description: 'Order number as the customer states it, e.g. 1042 or #1042.' },
          phone: { type: 'string', description: 'Caller phone number for verification.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bookCallback',
      description: 'Book a team member callback when the caller wants a human to call them back.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'phone', 'preferredTime'],
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          preferredTime: { type: 'string', description: 'Preferred callback window in the caller words.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchFAQ',
      description: 'Search the store FAQ knowledge base for a customer question.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string' },
        },
      },
    },
  },
];

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

async function appendCallAction(callLogId: string, entry: Record<string, unknown>): Promise<void> {
  const prisma = getVoicePrisma();
  const row = await prisma.callLog.findUnique({ where: { id: callLogId }, select: { actionsJson: true } });
  const prev = Array.isArray(row?.actionsJson) ? (row.actionsJson as unknown[]) : [];
  await prisma.callLog.update({
    where: { id: callLogId },
    data: { actionsJson: [...prev, entry] as object },
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
  const prisma = getVoicePrisma();
  const faqs = await prisma.faqItem.findMany({
    where: { storeKey: params.storeKey, isActive: true },
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    take: 25,
    select: { question: true, answer: true, category: true },
  });

  const system = buildSystemPrompt({ settings: params.settings, faqs });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...params.conversationalMessages,
  ];

  const lastUser = [...params.conversationalMessages].reverse().find((m) => m.role === 'user');
  const userText =
    typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
  await appendCallTranscript(params.callLogId, `[user]: ${userText}`);

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    for (const chunk of chunkTextForRelay('Our assistant is not fully configured yet. Goodbye.')) {
      params.sendText(chunk, false);
    }
    params.sendText('', true);
    return params.conversationalMessages;
  }

  const openai = new OpenAI({ apiKey: openaiKey });
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const toolCtx: ToolContext = { prisma, storeKey: params.storeKey, settings: params.settings };

  for (let round = 0; round < 12; round++) {
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: Number(process.env.OPENAI_TEMPERATURE ?? '0.4'),
    });

    const choice = completion.choices[0];
    const msg = choice?.message;
    if (!msg) break;

    messages.push(msg);

    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }

        let result: Record<string, unknown>;
        try {
          if (name === 'getOrderStatus') {
            result = await toolGetOrderStatus(toolCtx, {
              orderNumber: String(args.orderNumber ?? ''),
              phone: String(args.phone ?? ''),
            });
          } else if (name === 'bookCallback') {
            result = await toolBookCallback(toolCtx, {
              name: String(args.name ?? ''),
              phone: String(args.phone ?? ''),
              preferredTime: String(args.preferredTime ?? ''),
            });
          } else if (name === 'searchFAQ') {
            result = await toolSearchFaq(toolCtx, { query: String(args.query ?? '') });
          } else {
            result = { ok: false, message: `Unknown tool: ${name}` };
          }
        } catch (e) {
          result = { ok: false, message: e instanceof Error ? e.message : 'Tool failed' };
        }

        await appendCallAction(params.callLogId, { tool: name, args, result, at: new Date().toISOString() });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const text = (msg.content ?? '').trim();
    const chunks = chunkTextForRelay(text);
    if (chunks.length === 0) {
      params.sendText('Okay.', true);
    } else {
      for (let i = 0; i < chunks.length; i++) {
        params.sendText(chunks[i]!, i === chunks.length - 1);
      }
    }

    await appendCallTranscript(params.callLogId, `[assistant]: ${text || 'Okay.'}`);

    // Persist only non-system messages for the session tail.
    return messages.slice(1);
  }

  for (const chunk of chunkTextForRelay(FALLBACK_SPEECH)) {
    params.sendText(chunk, false);
  }
  params.sendText('', true);
  return params.conversationalMessages;
}
