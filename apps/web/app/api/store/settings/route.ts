import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@bookstore-voice-agents/voice-db';
import { getVoicePrisma } from '@/lib/voice/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function assertAdmin(request: NextRequest): boolean {
  const expected = process.env.VOICE_ADMIN_API_KEY?.trim();
  if (!expected) return true; // dev convenience; set VOICE_ADMIN_API_KEY in production
  const got = request.headers.get('x-voice-admin-key');
  return got === expected;
}

export async function GET(request: NextRequest) {
  if (!assertAdmin(request)) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const storeKey = request.nextUrl.searchParams.get('storeKey')?.trim();
  if (!storeKey) {
    return NextResponse.json({ message: 'Missing storeKey query parameter' }, { status: 400 });
  }

  const prisma = getVoicePrisma();
  const store = await prisma.storeSetting.findUnique({
    where: { storeKey },
    include: {
      faqItems: { where: { isActive: true }, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }] },
    },
  });

  if (!store) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  const { shopifyAdminToken: _t, ...safe } = store;
  return NextResponse.json({
    ...safe,
    shopifyAdminTokenConfigured: Boolean(_t),
  });
}

type FaqUpsert = { question: string; answer: string; category?: string; priority?: number; isActive?: boolean };

export async function POST(request: NextRequest) {
  if (!assertAdmin(request)) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as null | {
    storeKey: string;
    storeName?: string;
    greeting?: string;
    timezone?: string;
    hoursJson?: unknown;
    shippingPolicy?: string;
    returnsPolicy?: string;
    storePolicyNotes?: string;
    escalationPhone?: string;
    shopifyDomain?: string | null;
    shopifyAdminToken?: string | null;
    faqs?: FaqUpsert[];
  };

  if (!body?.storeKey?.trim()) {
    return NextResponse.json({ message: 'storeKey is required' }, { status: 400 });
  }

  const prisma = getVoicePrisma();
  const storeKey = body.storeKey.trim();

  const saved = await prisma.storeSetting.upsert({
    where: { storeKey },
    create: {
      storeKey,
      storeName: body.storeName?.trim() || 'Store',
      greeting: body.greeting?.trim(),
      timezone: body.timezone?.trim(),
      hoursJson:
        body.hoursJson === undefined ? undefined : (body.hoursJson as Prisma.InputJsonValue),
      shippingPolicy: body.shippingPolicy,
      returnsPolicy: body.returnsPolicy,
      storePolicyNotes: body.storePolicyNotes,
      escalationPhone: body.escalationPhone,
      shopifyDomain: body.shopifyDomain?.trim() || null,
      shopifyAdminToken: body.shopifyAdminToken?.trim() || null,
    },
    update: {
      storeName: body.storeName?.trim() || undefined,
      greeting: body.greeting === undefined ? undefined : body.greeting?.trim(),
      timezone: body.timezone === undefined ? undefined : body.timezone?.trim(),
      hoursJson:
        body.hoursJson === undefined
          ? undefined
          : body.hoursJson === null
            ? Prisma.JsonNull
            : (body.hoursJson as Prisma.InputJsonValue),
      shippingPolicy: body.shippingPolicy === undefined ? undefined : body.shippingPolicy,
      returnsPolicy: body.returnsPolicy === undefined ? undefined : body.returnsPolicy,
      storePolicyNotes: body.storePolicyNotes === undefined ? undefined : body.storePolicyNotes,
      escalationPhone: body.escalationPhone === undefined ? undefined : body.escalationPhone,
      shopifyDomain: body.shopifyDomain === undefined ? undefined : body.shopifyDomain?.trim() || null,
      shopifyAdminToken:
        body.shopifyAdminToken === undefined ? undefined : body.shopifyAdminToken?.trim() || null,
    },
  });

  if (Array.isArray(body.faqs)) {
    await prisma.faqItem.deleteMany({ where: { storeKey } });
    for (const f of body.faqs) {
      if (!f?.question?.trim() || !f?.answer?.trim()) continue;
      await prisma.faqItem.create({
        data: {
          storeKey,
          question: f.question.trim(),
          answer: f.answer.trim(),
          category: f.category?.trim() || null,
          priority: typeof f.priority === 'number' ? f.priority : 0,
          isActive: f.isActive !== false,
        },
      });
    }
  }

  const { shopifyAdminToken: _t, ...safe } = saved;
  return NextResponse.json({
    ...safe,
    shopifyAdminTokenConfigured: Boolean(_t),
  });
}
