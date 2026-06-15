import { Injectable, Logger } from '@nestjs/common';
import { CallerIdentityService } from '../caller-identity/caller-identity.service';
import { ShopifyCustomerLookupService } from '../caller-identity/shopify-customer-lookup.service';
import { ThreeCxCallerService } from '../caller-identity/three-cx-caller.service';
import { normalizeCallerPhone } from '../caller-identity/utils/caller-phone.util';
import { parseCallerCallHistory } from './utils/caller-call-history.util';
import {
  buildConversationInitiation,
  maskPhoneForLog,
  type ElevenLabsConversationInitiation,
  type ReturningCallerLookupResult,
} from './utils/returning-caller-personalization.util';

export type PrepareInboundCallResult = {
  phoneRaw: string;
  phoneNormalized: string;
  lookup: ReturningCallerLookupResult;
  initiation: ElevenLabsConversationInitiation;
};

@Injectable()
export class ReturningCallerService {
  private readonly logger = new Logger(ReturningCallerService.name);

  constructor(
    private readonly callerIdentity: CallerIdentityService,
    private readonly shopifyCustomer: ShopifyCustomerLookupService,
    private readonly threeCxCaller: ThreeCxCallerService,
  ) {}

  async prepareInboundCall(args: {
    rawFrom: string;
    callSid: string;
  }): Promise<PrepareInboundCallResult> {
    const { normalized } = normalizeCallerPhone(args.rawFrom);
    const phoneNormalized = normalized || args.rawFrom.trim();
    const masked = maskPhoneForLog(args.rawFrom, phoneNormalized);

    this.logger.log(
      JSON.stringify({
        event: 'caller_phone_normalized',
        callSid: args.callSid,
        phoneRawMasked: masked.rawMasked,
        phoneNormalizedMasked: masked.normalizedMasked,
      }),
    );

    this.logger.log(
      JSON.stringify({
        event: 'caller_lookup_started',
        callSid: args.callSid,
        phoneNormalizedMasked: masked.normalizedMasked,
      }),
    );

    let lookup: ReturningCallerLookupResult;
    try {
      lookup = await this.lookupReturningCaller(args.rawFrom, args.callSid);
      if (lookup.callerRecognized) {
        this.logger.log(
          JSON.stringify({
            event: 'caller_lookup_success',
            callSid: args.callSid,
            hasFirstName: Boolean(lookup.customerFirstName),
            totalPreviousCalls: lookup.totalPreviousCalls,
            customerIdPresent: Boolean(lookup.customerId),
          }),
        );
      } else {
        this.logger.log(
          JSON.stringify({
            event: 'caller_lookup_not_found',
            callSid: args.callSid,
          }),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'caller_lookup_failed',
          callSid: args.callSid,
          message: message.slice(0, 300),
        }),
      );
      lookup = emptyLookup();
    }

    try {
      await this.callerIdentity.touchInboundCallHistory({
        phone: args.rawFrom,
        callSid: args.callSid,
        displayName: lookup.customerFullName,
        firstName: lookup.customerFirstName,
        customerId: lookup.customerId,
        lastOrderNumber: lookup.lastOrderNumber,
        source: lookup.customerId ? 'shopify_orders' : 'agent_capture',
      });
    } catch (trackErr) {
      const trackMessage = trackErr instanceof Error ? trackErr.message : String(trackErr);
      this.logger.warn(
        JSON.stringify({
          event: 'caller_profile_track_failed',
          callSid: args.callSid,
          message: trackMessage.slice(0, 200),
        }),
      );
    }

    const initiation = buildConversationInitiation(lookup);
    return { phoneRaw: args.rawFrom, phoneNormalized, lookup, initiation };
  }

  private async lookupReturningCaller(
    rawFrom: string,
    callSid: string,
  ): Promise<ReturningCallerLookupResult> {
    const identity = await this.callerIdentity.resolveCallerIdentity(rawFrom, {
      excludeCallSid: callSid,
    });

    const shopifyMatch = await this.shopifyCustomer.findCustomerByPhone(rawFrom).catch(() => null);
    const profile = await this.callerIdentity.getCallerProfileByPhone(rawFrom);
    const history = parseCallerCallHistory(profile?.metadata);

    let firstName = identity.firstName ?? shopifyMatch?.firstName ?? profile?.firstName ?? null;
    let fullName =
      identity.displayName ??
      shopifyMatch?.displayName ??
      profile?.displayName ??
      ([shopifyMatch?.firstName, shopifyMatch?.lastName].filter(Boolean).join(' ').trim() || null);
    const customerId = shopifyMatch?.customerId ?? profile?.externalId ?? null;

    if (!firstName || !fullName) {
      const threeCx = await this.threeCxCaller
        .getCallerInfo(rawFrom, { excludeCallSid: callSid })
        .catch(() => null);
      if (threeCx) {
        firstName = firstName ?? threeCx.first_name ?? null;
        fullName = fullName ?? threeCx.full_name ?? null;
      }
    }

    const lastOrderNumber =
      history?.last_order_number ??
      shopifyMatch?.purchases.find((p) => p.orderName)?.orderName ??
      null;
    const lastCallSummary = history?.last_call_summary ?? null;

    const totalPreviousCalls = Math.max(
      identity.priorCallCount,
      history ? Math.max(0, history.total_calls) : 0,
    );

    const callerRecognized =
      Boolean(firstName || fullName || customerId) ||
      totalPreviousCalls > 0 ||
      identity.isReturningCaller;

    if (!callerRecognized) {
      return emptyLookup();
    }

    return {
      callerRecognized: true,
      customerId,
      customerFirstName: firstName,
      customerFullName: fullName,
      totalPreviousCalls,
      lastOrderNumber,
      lastCallSummary,
      callerPhoneVerified: 'partial',
    };
  }
}

function emptyLookup(): ReturningCallerLookupResult {
  return {
    callerRecognized: false,
    customerId: null,
    customerFirstName: null,
    customerFullName: null,
    totalPreviousCalls: 0,
    lastOrderNumber: null,
    lastCallSummary: null,
    callerPhoneVerified: 'none',
  };
}
