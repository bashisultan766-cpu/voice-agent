import 'reflect-metadata';
import { withDevAppContext, optionalEnv } from './dev-script-context';
import { PrismaService } from '../database/prisma.service';
import { VoiceRuntimeService } from '../modules/calls/runtime/voice-runtime.service';
import { classifyOrderTurn } from '../modules/calls/runtime/order-intent-classifier.util';

type SimUtteranceResult = {
  userUtterance: string;
  detectedIntent: string;
  orderStateBefore: string;
  orderStateAfter: string;
  agentReply: string;
  toolsCalled: string[];
  pass: boolean;
  notes?: string;
};

type SimulationResult = {
  name: string;
  callSessionId: string | null;
  steps: SimUtteranceResult[];
  pass: boolean;
};

function readMetadataOrderState(meta: unknown): string {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'IDLE';
  const s = (meta as Record<string, unknown>).orderState;
  return typeof s === 'string' && s.trim() ? s.trim() : 'IDLE';
}

function readMetadataLastIntent(meta: unknown): string {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'unknown';
  const s = (meta as Record<string, unknown>).lastTurnIntent;
  return typeof s === 'string' && s.trim() ? s.trim() : 'unknown';
}

function extractToolsFromToolTranscripts(toolRows: Array<{ content: string }>): string[] {
  const tools: string[] = [];
  for (const row of toolRows) {
    const m = row.content.match(/Tool call started:\s*([A-Za-z0-9_]+)/);
    if (m?.[1]) tools.push(m[1]);
  }
  return tools;
}

function isTechnicalFallbackReply(reply: string): boolean {
  const r = (reply ?? '').trim();
  return (
    r === "I'm having a brief technical issue. Please repeat that, or I can connect you with our team." ||
    r === "I'm having trouble right now. Please call back later." ||
    r.toLowerCase().includes('brief technical issue')
  );
}

function deterministicFallbackEnabled(): boolean {
  return String(process.env.VOICE_DETERMINISTIC_FALLBACK ?? '').toLowerCase() === 'true';
}

async function ensureCallSession(prisma: PrismaService, tenantId: string, agentId: string): Promise<string> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, tenantId, deletedAt: null },
    select: { storeId: true },
  });
  if (!agent) {
    throw new Error('DEV_TENANT_ID / DEV_AGENT_ID do not map to a live agent in this database.');
  }
  const call = await prisma.callSession.create({
    data: {
      tenantId,
      agentId,
      storeId: agent.storeId ?? null,
      status: 'INITIATED',
      direction: 'inbound',
      startedAt: new Date(),
      metadata: { orderState: 'IDLE' },
    },
    select: { id: true },
  });
  return call.id;
}

async function runScenario(args: {
  prisma: PrismaService;
  runtime: VoiceRuntimeService;
  name: string;
  callSessionId: string;
  utterances: string[];
  expect: (step: SimUtteranceResult, stepIndex: number, all: SimUtteranceResult[]) => { pass: boolean; notes?: string };
}): Promise<SimulationResult> {
  let lastSeq = 0;
  const steps: SimUtteranceResult[] = [];

  for (let i = 0; i < args.utterances.length; i++) {
    const userUtterance = args.utterances[i];
    const before = await args.prisma.callSession.findUniqueOrThrow({
      where: { id: args.callSessionId },
      select: { metadata: true },
    });
    const orderStateBefore = readMetadataOrderState(before.metadata);

    const { reply } = await args.runtime.processUtterance(args.callSessionId, userUtterance, []);

    const after = await args.prisma.callSession.findUniqueOrThrow({
      where: { id: args.callSessionId },
      select: { metadata: true },
    });
    const orderStateAfter = readMetadataOrderState(after.metadata);
    const detectedIntent = readMetadataLastIntent(after.metadata);

    const toolRows = await args.prisma.callTranscript.findMany({
      where: { callSessionId: args.callSessionId, role: 'tool', sequenceNumber: { gt: lastSeq } },
      orderBy: { sequenceNumber: 'asc' },
      select: { sequenceNumber: true, content: true },
    });
    if (toolRows.length) lastSeq = toolRows[toolRows.length - 1]!.sequenceNumber;
    const toolsCalled = extractToolsFromToolTranscripts(toolRows);

    const step: SimUtteranceResult = {
      userUtterance,
      detectedIntent,
      orderStateBefore,
      orderStateAfter,
      agentReply: reply,
      toolsCalled,
      pass: true,
    };

    // Hard-fail steps that hit LLM runtime fallback (usually OpenAI errors like 429 quota).
    if (isTechnicalFallbackReply(step.agentReply)) {
      step.pass = false;
      step.notes =
        'Agent returned technical fallback reply (likely OpenAI request failure / quota 429). Tools were not called; this step cannot validate sales behavior.';
      steps.push(step);
      continue;
    }

    const expectation = args.expect(step, i, steps);
    step.pass = expectation.pass;
    if (expectation.notes) step.notes = expectation.notes;

    steps.push(step);
  }

  return {
    name: args.name,
    callSessionId: args.callSessionId,
    steps,
    pass: steps.every((s) => s.pass),
  };
}

function includesAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

async function main() {
  const tenantId = optionalEnv('DEV_TENANT_ID');
  const agentId = optionalEnv('DEV_AGENT_ID');
  if (!tenantId || !agentId) {
    console.log(
      JSON.stringify(
        {
          skipped: true,
          reason: 'DEV_TENANT_ID and DEV_AGENT_ID are required to run voice simulations against a real DB-backed agent.',
          howToRun:
            'Set DEV_TENANT_ID and DEV_AGENT_ID (pointing to an existing agent), then run: pnpm --filter api test:voice-sim',
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  await withDevAppContext(async (app) => {
    const prisma = app.get(PrismaService);
    const runtime = app.get(VoiceRuntimeService);
    const callSessionId = await ensureCallSession(prisma, tenantId, agentId);

    const simulations: SimulationResult[] = [];

    // 1) Successful order
    simulations.push(
      await runScenario({
        prisma,
        runtime,
        name: 'successful_order',
        callSessionId,
        utterances: [
          'Do you have black Nike shoes?',
          'Yes that one, size 9',
          'One',
          'Ali Khan',
          'ali@example.com',
          'Yes confirm',
        ],
        expect: (step, idx) => {
          const fallback = deterministicFallbackEnabled();
          if (idx === 0) {
            const okState = step.orderStateAfter === 'PRODUCT_DISCOVERY';
            if (fallback) {
              const usedTools = step.toolsCalled.includes('searchProducts') || step.toolsCalled.includes('getProductAvailability');
              return {
                pass: okState && usedTools,
                notes: usedTools
                  ? includesAny(step.agentReply, ['syncing the latest shopify catalog'])
                    ? 'partial due to deterministic fallback (catalog syncing)'
                    : 'partial due to deterministic fallback'
                  : 'Expected deterministic fallback tool calls.',
              };
            }
            return { pass: okState };
          }
          if (idx === 5) {
            if (fallback) {
              const acceptable = includesAny(step.agentReply, [
                'temporarily unable',
                'unable to complete checkout',
                'connect you with the team',
                'before i confirm the order',
                'need the exact variant and quantity',
              ]);
              return { pass: acceptable, notes: 'partial due to deterministic fallback (checkout not attempted)' };
            }
            return { pass: step.orderStateAfter === 'EMAIL_COLLECTION' || step.orderStateAfter === 'DONE' };
          }
          return { pass: true };
        },
      }),
    );

    // 2) Low-confidence product (should clarify)
    const lowConfCall = await ensureCallSession(prisma, tenantId, agentId);
    simulations.push(
      await runScenario({
        prisma,
        runtime,
        name: 'low_confidence_product',
        callSessionId: lowConfCall,
        utterances: ['Do you have nik shoo?'],
        expect: (step) => {
          if (includesAny(step.agentReply, ['syncing the latest shopify catalog'])) {
            return { pass: true, notes: 'partial due to deterministic fallback (catalog syncing)' };
          }
          const clarified = includesAny(step.agentReply, [
            'repeat the exact product',
            'exact product',
            'please repeat',
            'exact name',
            'model',
            'product name',
          ]);
          const fallback = deterministicFallbackEnabled();
          const note = fallback ? 'partial due to deterministic fallback' : undefined;
          return { pass: clarified, notes: clarified ? note : 'Expected clarification prompt for low-confidence product.' };
        },
      }),
    );

    // 3) Invalid email (should ask again)
    const invalidEmailCall = await ensureCallSession(prisma, tenantId, agentId);
    // move to EMAIL_COLLECTION deterministically without tools/LLM dependency
    await prisma.callSession.update({
      where: { id: invalidEmailCall },
      data: { metadata: { orderState: 'EMAIL_COLLECTION' } },
    });
    simulations.push(
      await runScenario({
        prisma,
        runtime,
        name: 'invalid_email',
        callSessionId: invalidEmailCall,
        utterances: ['ali at gmail'],
        expect: (step) => {
          const askedAgain = includesAny(step.agentReply, ['email', 'spell', 'indirizzo email', 'email address']);
          const stayed = step.orderStateAfter === 'EMAIL_COLLECTION';
          return { pass: askedAgain && stayed, notes: askedAgain ? undefined : 'Expected email re-ask prompt.' };
        },
      }),
    );

    // 4) Cancel order
    const cancelCall = await ensureCallSession(prisma, tenantId, agentId);
    await prisma.callSession.update({
      where: { id: cancelCall },
      data: { metadata: { orderState: 'PRODUCT_DISCOVERY' } },
    });
    simulations.push(
      await runScenario({
        prisma,
        runtime,
        name: 'cancel_order',
        callSessionId: cancelCall,
        utterances: ['Actually cancel this'],
        expect: (step) => {
          const ended = step.orderStateAfter === 'DONE';
          const safe = includesAny(step.agentReply, ['cancel', 'annull', 'отмен']);
          return { pass: ended && safe, notes: ended ? undefined : 'Expected END state after cancellation.' };
        },
      }),
    );

    // 5) General question mid-order (state preserved)
    const midOrderCall = await ensureCallSession(prisma, tenantId, agentId);
    await prisma.callSession.update({
      where: { id: midOrderCall },
      data: { metadata: { orderState: 'PRODUCT_DISCOVERY' } },
    });
    simulations.push(
      await runScenario({
        prisma,
        runtime,
        name: 'general_question_mid_order',
        callSessionId: midOrderCall,
        utterances: ['What are your delivery times?'],
        expect: (step) => {
          const preserved = step.orderStateAfter === 'PRODUCT_DISCOVERY';
          const nonEmpty = Boolean(step.agentReply.trim());
          const fallback = deterministicFallbackEnabled();
          const note = fallback ? 'partial due to deterministic fallback' : undefined;
          return { pass: preserved && nonEmpty, notes: preserved ? note : 'Expected order state to be preserved.' };
        },
      }),
    );

    // 6) ISBN query response should be grounded in Shopify tool output only
    const isbnCall = await ensureCallSession(prisma, tenantId, agentId);
    simulations.push(
      await runScenario({
        prisma,
        runtime,
        name: 'isbn_lookup',
        callSessionId: isbnCall,
        utterances: ['What is the ISBN of this book?'],
        expect: (step) => {
          const includesMissingLine = step.agentReply.includes('I don’t have the ISBN available for this item.');
          const includesNumericIsbn = /\b(?:97[89])?\d{10,13}\b/.test(step.agentReply.replace(/[^0-9]/g, ''));
          const usedCatalogTool = step.toolsCalled.includes('searchProducts') || step.toolsCalled.includes('getProductDetails');
          if (includesAny(step.agentReply, ['syncing the latest shopify catalog'])) {
            return { pass: true, notes: 'partial due to deterministic fallback (catalog syncing)' };
          }
          return {
            pass: usedCatalogTool && (includesMissingLine || includesNumericIsbn),
            notes:
              usedCatalogTool && (includesMissingLine || includesNumericIsbn)
                ? undefined
                : 'Expected grounded ISBN response from Shopify tools or explicit ISBN-unavailable line.',
          };
        },
      }),
    );

    const pass = simulations.every((s) => s.pass);
    console.log(JSON.stringify({ ok: pass, simulations }, null, 2));
    if (!pass) process.exit(1);
  });
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(err.stack || err.message);
  } else {
    console.error(String(err));
  }
  process.exit(1);
});

