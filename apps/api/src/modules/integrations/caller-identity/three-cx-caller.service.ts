import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallerIdentityService } from './caller-identity.service';
import { ShopifyCustomerLookupService } from './shopify-customer-lookup.service';
import { ThreeCxApiClient } from './three-cx-api.client';
import {
  buildGetCallerInfoResponse,
  GetCallerInfoResponse,
} from './utils/build-get-caller-info-response.util';
import { normalizeCallerPhone } from './utils/caller-phone.util';

@Injectable()
export class ThreeCxCallerService {
  private readonly logger = new Logger(ThreeCxCallerService.name);

  constructor(
    private readonly threeCx: ThreeCxApiClient,
    private readonly callerIdentity: CallerIdentityService,
    private readonly shopifyCustomers: ShopifyCustomerLookupService,
    private readonly config: ConfigService,
  ) {}

  isLiveApiEnabled(): boolean {
    return this.threeCx.isConfigured();
  }

  async getCallerInfo(
    rawPhone: string,
    options?: { excludeCallSid?: string },
  ): Promise<GetCallerInfoResponse> {
    const { normalized } = normalizeCallerPhone(rawPhone);
    const phoneNumber = normalized || rawPhone.trim();
    const threeCxConfigured = this.threeCx.isConfigured();

    if (!threeCxConfigured) {
      const [local, purchases, shopifyCustomer] = await Promise.all([
        this.callerIdentity.resolveCallerIdentity(phoneNumber, options),
        this.callerIdentity.getPurchaseHistoryByPhone(phoneNumber),
        this.shopifyCustomers.findCustomerByPhone(phoneNumber).catch(() => null),
      ]);

      const merged = mergeShopifyIntoPurchases(purchases, shopifyCustomer);
      const displayName = local.displayName || shopifyCustomer?.displayName || null;

      await this.cacheShopifyName(phoneNumber, local.displayName, shopifyCustomer);

      return buildGetCallerInfoResponse({
        phoneNumber,
        threeCxConfigured: false,
        contact: null,
        callHistory: [],
        recordings: [],
        recordingUrls: [],
        localPriorCallCount: local.priorCallCount,
        localDisplayName: displayName,
        pastPurchases: merged.items,
        totalPastOrders: merged.totalOrders,
        lastPurchaseDate: merged.lastPurchaseDate,
        source: displayName ? (shopifyCustomer && !local.displayName ? 'mixed' : 'local_cache') : 'none',
      });
    }

    const [contact, callHistory, recordings, local, purchases, shopifyCustomer] = await Promise.all([
      this.threeCx.findContactByPhone(phoneNumber),
      this.threeCx.getCallHistoryForPhone(phoneNumber, 20),
      this.threeCx.getRecordingsForPhone(phoneNumber, 10),
      this.callerIdentity.resolveCallerIdentity(phoneNumber, options),
      this.callerIdentity.getPurchaseHistoryByPhone(phoneNumber),
      this.shopifyCustomers.findCustomerByPhone(phoneNumber).catch(() => null),
    ]);

    const publicBaseUrl =
      this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL')?.trim() ||
      `http://localhost:${this.config.get<string>('PORT') ?? '3001'}`;

    const recordingIds = new Set<string>();
    for (const row of callHistory) {
      if (row.recordingId) recordingIds.add(row.recordingId);
    }
    for (const row of recordings) {
      if (row.id) recordingIds.add(row.id);
    }

    const recordingUrls = [...recordingIds]
      .slice(0, 8)
      .map((recId) => this.threeCx.recordingDownloadPath(recId, publicBaseUrl));

    const source: GetCallerInfoResponse['source'] = contact
      ? local.displayName && local.displayName !== contact.displayName
        ? 'mixed'
        : 'three_cx_api'
      : local.displayName
        ? 'mixed'
        : 'three_cx_api';

    const merged = mergeShopifyIntoPurchases(purchases, shopifyCustomer);

    const response = buildGetCallerInfoResponse({
      phoneNumber,
      threeCxConfigured: true,
      contact,
      callHistory,
      recordings,
      recordingUrls,
      localPriorCallCount: local.priorCallCount,
      localDisplayName: local.displayName || shopifyCustomer?.displayName || null,
      pastPurchases: merged.items,
      totalPastOrders: merged.totalOrders,
      lastPurchaseDate: merged.lastPurchaseDate,
      source,
    });

    await this.cacheCallerProfileFromResponse(phoneNumber, response, contact);
    await this.cacheShopifyName(phoneNumber, local.displayName, shopifyCustomer);

    this.logger.log(
      JSON.stringify({
        event: 'three_cx.get_caller_info',
        exists: response.exists,
        isReturningCaller: response.is_returning_caller,
        callCount: response.call_count,
        hasRecordings: response.recording_urls.length > 0,
        phoneMasked: maskPhone(phoneNumber),
      }),
    );

    return response;
  }

  async saveCallerToThreeCx(input: {
    phone: string;
    name: string;
    email?: string;
  }): Promise<{ savedToThreeCx: boolean; contactId: string | null }> {
    if (!this.threeCx.isConfigured()) {
      return { savedToThreeCx: false, contactId: null };
    }

    const parts = input.name.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? input.name.trim();
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';

    const existing = await this.threeCx.findContactByPhone(input.phone);
    if (existing?.id) {
      return { savedToThreeCx: true, contactId: existing.id };
    }

    const created = await this.threeCx.createContact({
      phone: input.phone,
      firstName,
      lastName,
      displayName: input.name.trim(),
      email: input.email,
    });

    if (created?.id) {
      try {
        await this.callerIdentity.upsertCallerProfile({
          phone: input.phone,
          displayName: input.name.trim(),
          firstName,
          lastName,
          email: input.email,
          source: 'three_cx_api',
          externalId: created.id,
        });
      } catch (cacheErr) {
        const message = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
        this.logger.warn(
          JSON.stringify({
            event: 'three_cx.cache_after_create_failed',
            message: message.slice(0, 200),
          }),
        );
      }
    }

    return {
      savedToThreeCx: Boolean(created?.id),
      contactId: created?.id ?? null,
    };
  }

  async getIntegrationStatus(): Promise<{
    configured: boolean;
    connected: boolean;
    base_url: string | null;
    message: string;
  }> {
    const configured = this.threeCx.isConfigured();
    if (!configured) {
      return {
        configured: false,
        connected: false,
        base_url: null,
        message: 'Set THREE_CX_BASE_URL, THREE_CX_CLIENT_ID, THREE_CX_CLIENT_SECRET.',
      };
    }

    const probe = await this.threeCx.probeConnection();
    return {
      configured: true,
      connected: probe.ok,
      base_url: this.threeCx.baseUrl(),
      message: probe.message,
    };
  }

  /** Cache Shopify customer name so future calls greet instantly even if Shopify is slow. */
  private async cacheShopifyName(
    phoneNumber: string,
    existingLocalName: string | null,
    shopifyCustomer: Awaited<ReturnType<ShopifyCustomerLookupService['findCustomerByPhone']>>,
  ): Promise<void> {
    if (existingLocalName || !shopifyCustomer?.displayName) return;
    try {
      await this.callerIdentity.upsertCallerProfile({
        phone: phoneNumber,
        displayName: shopifyCustomer.displayName,
        firstName: shopifyCustomer.firstName ?? undefined,
        lastName: shopifyCustomer.lastName ?? undefined,
        email: shopifyCustomer.email ?? undefined,
        source: 'shopify_orders',
        externalId: shopifyCustomer.customerId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'three_cx.cache_shopify_name_failed',
          message: message.slice(0, 200),
        }),
      );
    }
  }

  private async cacheCallerProfileFromResponse(
    phoneNumber: string,
    response: GetCallerInfoResponse,
    contact: Awaited<ReturnType<ThreeCxApiClient['findContactByPhone']>>,
  ): Promise<void> {
    const displayName = response.full_name?.trim();
    if (!displayName) return;

    try {
      await this.callerIdentity.upsertCallerProfile({
        phone: phoneNumber,
        displayName,
        firstName: response.first_name ?? undefined,
        lastName: response.last_name ?? undefined,
        email: response.email ?? undefined,
        company: response.company ?? undefined,
        source: 'three_cx_api',
        externalId: response.contact_id ?? contact?.id ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'three_cx.cache_profile_failed',
          message: message.slice(0, 200),
        }),
      );
    }
  }
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

type LocalPurchaseHistory = Awaited<
  ReturnType<CallerIdentityService['getPurchaseHistoryByPhone']>
>;
type ShopifyCustomer = Awaited<ReturnType<ShopifyCustomerLookupService['findCustomerByPhone']>>;

/** Combine voice-agent invoice history with full Shopify order history (dedupe by title). */
function mergeShopifyIntoPurchases(
  local: LocalPurchaseHistory,
  shopifyCustomer: ShopifyCustomer,
): {
  items: Array<{ title: string; quantity: number; price: string | null; purchased_at: string | null }>;
  totalOrders: number;
  lastPurchaseDate: string | null;
} {
  const items: Array<{
    title: string;
    quantity: number;
    price: string | null;
    purchased_at: string | null;
  }> = [];
  const seen = new Set<string>();

  for (const item of local.items) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title: item.title,
      quantity: item.quantity,
      price: item.price,
      purchased_at: item.purchasedAt,
    });
  }

  for (const purchase of shopifyCustomer?.purchases ?? []) {
    const key = purchase.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title: purchase.title,
      quantity: purchase.quantity,
      price: null,
      purchased_at: purchase.purchasedAt,
    });
    if (items.length >= 10) break;
  }

  const candidates = [local.lastPurchaseDate, shopifyCustomer?.lastOrderDate ?? null].filter(
    (value): value is string => Boolean(value),
  );
  const lastPurchaseDate = candidates.sort().pop() ?? null;

  return {
    items,
    totalOrders: Math.max(local.totalOrders, shopifyCustomer?.ordersCount ?? 0),
    lastPurchaseDate,
  };
}
