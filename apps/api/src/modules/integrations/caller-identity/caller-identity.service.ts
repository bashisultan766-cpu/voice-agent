import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  parseThreeCxContactsCsv,
  parseThreeCxContactsJson,
  ThreeCxContactImportRow,
} from './utils/caller-profile-import.util';
import { normalizeCallerPhone, phoneDigitsKey, phonesLikelyMatch } from './utils/caller-phone.util';

export type CallerIdentitySource =
  | 'three_cx_import'
  | 'three_cx_api'
  | 'shopify_orders'
  | 'agent_capture'
  | 'none';

export type CallerIdentityResult = {
  phoneNormalized: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  isReturningCaller: boolean;
  priorCallCount: number;
  identitySource: CallerIdentitySource;
};

export type SaveCallerNameInput = {
  phone: string;
  name: string;
  email?: string;
  callSid?: string;
  tenantId?: string;
};

export type CallerPurchaseItem = {
  title: string;
  quantity: number;
  price: string | null;
  purchasedAt: string | null;
  email: string | null;
};

export type CallerPurchaseHistory = {
  items: CallerPurchaseItem[];
  totalOrders: number;
  lastPurchaseDate: string | null;
  knownEmails: string[];
};

@Injectable()
export class CallerIdentityService {
  private readonly logger = new Logger(CallerIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveCallerIdentity(
    rawPhone: string,
    options?: { excludeCallSid?: string },
  ): Promise<CallerIdentityResult> {
    const { normalized, digits } = normalizeCallerPhone(rawPhone);
    const profile = normalized
      ? await this.findProfileByPhone(normalized, digits)
      : null;

    const priorCallCount = normalized
      ? await this.countPriorInboundCalls(normalized, digits, options?.excludeCallSid)
      : 0;
    const hasPriorLead = normalized ? await this.hasPriorLeadCapture(normalized, digits) : false;
    const hasPriorPayment = normalized
      ? await this.hasPriorPaymentDelivery(normalized, digits)
      : false;

    const isReturningCaller = priorCallCount > 0 || hasPriorLead || hasPriorPayment;

    const firstName = profile?.firstName?.trim() || splitFirstName(profile?.displayName);
    const lastName = profile?.lastName?.trim() || splitLastName(profile?.displayName);

    return {
      phoneNormalized: normalized,
      displayName: profile?.displayName?.trim() || null,
      firstName,
      lastName,
      email: profile?.email?.trim() || null,
      isReturningCaller,
      priorCallCount,
      identitySource: profile ? normalizeIdentitySource(profile.source) : 'none',
    };
  }

  async upsertCallerProfile(input: {
    phone: string;
    displayName: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    company?: string;
    source: 'three_cx_import' | 'three_cx_api' | 'shopify_orders' | 'agent_capture';
    externalId?: string;
    tenantId?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<{ id: string; phoneNormalized: string; displayName: string }> {
    const { normalized, digits } = normalizeCallerPhone(input.phone);
    if (!normalized) {
      throw new Error('A valid phone number is required.');
    }

    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new Error('displayName is required.');
    }

    const firstName = input.firstName?.trim() || splitFirstName(displayName) || undefined;
    const lastName = input.lastName?.trim() || splitLastName(displayName) || undefined;

    const row = await this.prisma.callerProfile.upsert({
      where: { phoneNormalized: normalized },
      create: {
        tenantId: input.tenantId ?? null,
        phoneNormalized: normalized,
        phoneDigits: digits,
        displayName,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        email: input.email?.trim() || null,
        company: input.company?.trim() || null,
        source: input.source,
        externalId: input.externalId?.trim() || null,
        metadata: input.metadata ?? undefined,
      },
      update: {
        phoneDigits: digits,
        displayName,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        email: input.email?.trim() || undefined,
        company: input.company?.trim() || undefined,
        source: input.source,
        externalId: input.externalId?.trim() || undefined,
        metadata: input.metadata ?? undefined,
        tenantId: input.tenantId ?? undefined,
      },
    });

    return { id: row.id, phoneNormalized: row.phoneNormalized, displayName: row.displayName };
  }

  async saveCallerName(input: SaveCallerNameInput): Promise<{
    success: true;
    displayName: string;
    phoneNormalized: string;
  }> {
    const saved = await this.upsertCallerProfile({
      phone: input.phone,
      displayName: input.name.trim(),
      email: input.email,
      source: 'agent_capture',
      tenantId: input.tenantId,
    });

    this.logger.log(
      JSON.stringify({
        event: 'caller_identity.name_saved',
        phoneMasked: maskPhone(saved.phoneNormalized),
        callSid: input.callSid ?? null,
      }),
    );

    return {
      success: true,
      displayName: saved.displayName,
      phoneNormalized: saved.phoneNormalized,
    };
  }

  async importThreeCxContacts(
    payload: { csv?: string; contacts?: unknown },
    options?: { tenantId?: string },
  ): Promise<{ imported: number; skipped: number }> {
    const rows: ThreeCxContactImportRow[] = payload.csv
      ? parseThreeCxContactsCsv(payload.csv)
      : parseThreeCxContactsJson(payload.contacts ?? []);

    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      const displayName =
        row.displayName?.trim() ||
        [row.firstName?.trim(), row.lastName?.trim()].filter(Boolean).join(' ').trim();
      if (!displayName) {
        skipped++;
        continue;
      }

      try {
        await this.upsertCallerProfile({
          phone: row.phone,
          displayName,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          company: row.company,
          source: 'three_cx_import',
          externalId: row.externalId,
          tenantId: options?.tenantId,
        });
        imported++;
      } catch {
        skipped++;
      }
    }

    this.logger.log(
      JSON.stringify({
        event: 'caller_identity.three_cx_import_complete',
        imported,
        skipped,
      }),
    );

    return { imported, skipped };
  }

  async getCallerProfileByPhone(rawPhone: string) {
    const { normalized, digits } = normalizeCallerPhone(rawPhone);
    if (!normalized) return null;
    return this.findProfileByPhone(normalized, digits);
  }

  async touchInboundCallHistory(args: {
    phone: string;
    callSid: string;
    displayName?: string | null;
    firstName?: string | null;
    customerId?: string | null;
    lastOrderNumber?: string | null;
    source?: 'three_cx_import' | 'three_cx_api' | 'shopify_orders' | 'agent_capture';
  }): Promise<void> {
    const { normalized } = normalizeCallerPhone(args.phone);
    if (!normalized) return;

    const existing = await this.findProfileByPhone(
      normalized,
      phoneDigitsKey(normalized),
    );
    const prior = this.parseCallHistoryMetadata(existing?.metadata);
    const nowIso = new Date().toISOString();
    const history = {
      first_seen_at: prior?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
      total_calls: (prior?.total_calls ?? 0) + 1,
      last_call_sid: args.callSid,
      last_order_number: args.lastOrderNumber ?? prior?.last_order_number ?? null,
      last_intent: prior?.last_intent ?? null,
      last_call_summary: prior?.last_call_summary ?? null,
    };

    const displayName =
      args.displayName?.trim() ||
      existing?.displayName?.trim() ||
      args.firstName?.trim() ||
      'Unknown Caller';

    const source =
      args.source ??
      (existing?.source === 'three_cx_import' ||
      existing?.source === 'three_cx_api' ||
      existing?.source === 'shopify_orders' ||
      existing?.source === 'agent_capture'
        ? existing.source
        : 'agent_capture');

    await this.upsertCallerProfile({
      phone: normalized,
      displayName,
      firstName: args.firstName ?? undefined,
      source,
      externalId: args.customerId ?? existing?.externalId ?? undefined,
      metadata: this.mergeCallHistoryMetadata(existing?.metadata, history),
    });
  }

  /** 3CX CRM lookup response shape (FirstName, LastName, ContactID, …). */
  async lookupForThreeCxCrm(rawPhone: string): Promise<{
    FirstName: string;
    LastName: string;
    CompanyName: string;
    Email: string;
    ContactID: string;
    PhoneBusiness: string;
  }> {
    const identity = await this.resolveCallerIdentity(rawPhone);
    if (!identity.displayName) {
      return {
        FirstName: '',
        LastName: '',
        CompanyName: '',
        Email: '',
        ContactID: '',
        PhoneBusiness: identity.phoneNormalized,
      };
    }

    const profile = identity.phoneNormalized
      ? await this.findProfileByPhone(
          identity.phoneNormalized,
          phoneDigitsKey(identity.phoneNormalized),
        )
      : null;

    return {
      FirstName: identity.firstName ?? '',
      LastName: identity.lastName ?? '',
      CompanyName: profile?.company?.trim() ?? '',
      Email: identity.email ?? '',
      ContactID: profile?.id ?? '',
      PhoneBusiness: identity.phoneNormalized,
    };
  }

  /**
   * What this caller bought before — PaymentDelivery (phone → emails) joined to
   * CheckoutLink.itemsJson (product titles). Powers "last time you bought X".
   */
  async getPurchaseHistoryByPhone(rawPhone: string, maxItems = 10): Promise<CallerPurchaseHistory> {
    const { normalized } = normalizeCallerPhone(rawPhone);
    const empty: CallerPurchaseHistory = {
      items: [],
      totalOrders: 0,
      lastPurchaseDate: null,
      knownEmails: [],
    };
    if (!normalized) return empty;

    const deliveries = await this.prisma.paymentDelivery.findMany({
      where: { customerPhone: { not: null } },
      select: { customerPhone: true, customerEmail: true, createdAt: true },
      take: 300,
      orderBy: { createdAt: 'desc' },
    });

    const emails = new Set<string>();
    for (const row of deliveries) {
      if (row.customerPhone && phonesLikelyMatch(row.customerPhone, normalized)) {
        const email = row.customerEmail?.trim().toLowerCase();
        if (email) emails.add(email);
      }
    }

    const profile = await this.prisma.callerProfile.findUnique({
      where: { phoneNormalized: normalized },
      select: { email: true },
    });
    if (profile?.email?.trim()) emails.add(profile.email.trim().toLowerCase());

    if (emails.size === 0) return empty;

    const links = await this.prisma.checkoutLink.findMany({
      where: {
        customerEmail: { in: [...emails], mode: 'insensitive' },
        status: { in: ['SENT', 'OPENED', 'COMPLETED'] },
      },
      select: { itemsJson: true, customerEmail: true, sentAt: true, createdAt: true },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });

    const items: CallerPurchaseItem[] = [];
    let lastPurchaseDate: string | null = null;

    for (const link of links) {
      const when = (link.sentAt ?? link.createdAt)?.toISOString() ?? null;
      if (when && (!lastPurchaseDate || when > lastPurchaseDate)) {
        lastPurchaseDate = when;
      }
      if (!Array.isArray(link.itemsJson)) continue;
      for (const row of link.itemsJson as Array<Record<string, unknown>>) {
        if (!row || typeof row !== 'object') continue;
        const title = typeof row.title === 'string' ? row.title.trim() : '';
        if (!title) continue;
        items.push({
          title,
          quantity: Math.max(1, Number(row.quantity ?? 1) || 1),
          price: row.price != null ? String(row.price) : null,
          purchasedAt: when,
          email: link.customerEmail?.trim().toLowerCase() ?? null,
        });
      }
    }

    const deduped: CallerPurchaseItem[] = [];
    const seenTitles = new Set<string>();
    for (const item of items) {
      const key = item.title.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      deduped.push(item);
      if (deduped.length >= maxItems) break;
    }

    return {
      items: deduped,
      totalOrders: links.length,
      lastPurchaseDate,
      knownEmails: [...emails],
    };
  }

  private async findProfileByPhone(normalized: string, digits: string) {
    const exact = await this.prisma.callerProfile.findUnique({
      where: { phoneNormalized: normalized },
    });
    if (exact) return exact;

    if (digits.length < 10) return null;

    return this.prisma.callerProfile.findFirst({
      where: { phoneDigits: digits },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async countPriorInboundCalls(
    normalized: string,
    digits: string,
    excludeCallSid?: string,
  ): Promise<number> {
    const rows = await this.prisma.inboundCall.findMany({
      where: excludeCallSid ? { callSid: { not: excludeCallSid } } : undefined,
      select: { callerPhone: true },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });

    return rows.filter((row) => phonesLikelyMatch(row.callerPhone, normalized)).length;
  }

  private async hasPriorLeadCapture(normalized: string, digits: string): Promise<boolean> {
    const rows = await this.prisma.leadCapture.findMany({
      where: { customerPhone: { not: null } },
      select: { customerPhone: true },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });
    return rows.some(
      (row) => row.customerPhone && phonesLikelyMatch(row.customerPhone, normalized),
    );
  }

  private async hasPriorPaymentDelivery(normalized: string, digits: string): Promise<boolean> {
    const rows = await this.prisma.paymentDelivery.findMany({
      where: { customerPhone: { not: null } },
      select: { customerPhone: true },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });
    return rows.some(
      (row) => row.customerPhone && phonesLikelyMatch(row.customerPhone, normalized),
    );
  }

  private parseCallHistoryMetadata(metadata: unknown): {
    first_seen_at: string;
    last_seen_at: string;
    total_calls: number;
    last_order_number: string | null;
    last_intent: string | null;
    last_call_summary: string | null;
  } | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const raw = (metadata as Record<string, unknown>).call_history;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const first_seen_at = typeof record.first_seen_at === 'string' ? record.first_seen_at : null;
    const last_seen_at = typeof record.last_seen_at === 'string' ? record.last_seen_at : null;
    if (!first_seen_at || !last_seen_at) return null;
    return {
      first_seen_at,
      last_seen_at,
      total_calls: Math.max(0, Number(record.total_calls ?? 0) || 0),
      last_order_number:
        typeof record.last_order_number === 'string' ? record.last_order_number : null,
      last_intent: typeof record.last_intent === 'string' ? record.last_intent : null,
      last_call_summary:
        typeof record.last_call_summary === 'string' ? record.last_call_summary : null,
    };
  }

  private mergeCallHistoryMetadata(
    metadata: unknown,
    history: Record<string, unknown>,
  ): Prisma.InputJsonValue {
    const base =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...(metadata as Record<string, unknown>) }
        : {};
    return { ...base, call_history: history } as Prisma.InputJsonValue;
  }
}

function normalizeIdentitySource(source: string): CallerIdentitySource {
  switch (source) {
    case 'agent_capture':
    case 'three_cx_api':
    case 'shopify_orders':
    case 'three_cx_import':
      return source;
    default:
      return 'three_cx_import';
  }
}

function splitFirstName(displayName?: string | null): string | null {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  return parts[0] ?? null;
}

function splitLastName(displayName?: string | null): string | null {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(1).join(' ');
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}
