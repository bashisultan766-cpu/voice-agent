import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { VoiceOrderLookupService } from './voice-order-lookup.service';
import { FacilityApprovalService } from './facility-approval.service';
import { findCatalogInventoryOverride } from '../data/voice-catalog-overrides.data';
import { sanitizeCustomerFacingText } from '../utils/voice-agent-language.util';
import { partitionCustomerFacingLineItems } from '../utils/sanitize-voice-commerce-response.util';

export type FacilityItemRestriction = {
  title: string;
  sku: string | null;
  status: 'accepted' | 'not_accepted' | 'needs_review';
  reason: string;
};

export type FacilityRestrictionResult = {
  success: boolean;
  order_number?: string;
  facility_name: string | null;
  facility_approval_status: string;
  items: FacilityItemRestriction[];
  restricted_items: FacilityItemRestriction[];
  suggested_response: string;
  escalate?: boolean;
  escalation_reason?: string;
  error?: string;
};

function detectBookFormat(title: string, variantTitle: string | null): 'hardcover' | 'paperback' | 'unknown' {
  const combined = `${title} ${variantTitle ?? ''}`.toLowerCase();
  if (combined.includes('hardcover') || combined.includes('hard cover')) return 'hardcover';
  if (combined.includes('paperback') || combined.includes('softcover') || combined.includes('soft cover')) {
    return 'paperback';
  }
  return 'unknown';
}

function matchesRestrictedCategory(title: string, categories: string[]): string | null {
  const lower = title.toLowerCase();
  for (const cat of categories) {
    const c = cat.toLowerCase();
    if (c === 'hardcover' && lower.includes('hardcover')) return cat;
    if (c === 'explicit' && /\b(explicit|xxx|erotic)\b/.test(lower)) return cat;
    if (c === 'gang-related' && /\b(gang|cartel)\b/.test(lower)) return cat;
    if (c === 'true crime' && /\b(true crime|serial killer)\b/.test(lower)) return cat;
    if (lower.includes(c)) return cat;
  }
  return null;
}

@Injectable()
export class FacilityRestrictionService {
  private readonly logger = new Logger(FacilityRestrictionService.name);

  constructor(
    private readonly orderLookup: VoiceOrderLookupService,
    private readonly facilityApproval: FacilityApprovalService,
  ) {}

  async checkOrderFacilityRestrictions(args: {
    orderNumber: string;
    facilityName?: string;
    tenantId?: string;
    agentId?: string;
    callSid?: string;
  }): Promise<FacilityRestrictionResult> {
    const orderNumber = args.orderNumber?.trim();
    if (!orderNumber) throw new BadRequestException('order_number is required.');

    try {
      const order = await this.orderLookup.lookupOrder({
        orderNumber,
        tenantId: args.tenantId,
        agentId: args.agentId,
      });

      if (!order) {
        return {
          success: false,
          facility_name: args.facilityName ?? null,
          facility_approval_status: 'unknown',
          items: [],
          restricted_items: [],
          suggested_response: 'I could not find that order to check facility restrictions.',
          error: 'order_not_found',
        };
      }

      const facilityName =
        args.facilityName?.trim() ||
        order.shippingAddress?.name ||
        order.shippingAddress?.city ||
        'the destination facility';

      const approval = this.facilityApproval.checkFacilityApproval({
        facilityName,
        city: order.shippingAddress?.city ?? undefined,
        state: order.shippingAddress?.provinceCode ?? undefined,
        callSid: args.callSid,
      });

      const rules = approval.rules;
      const customerFacingLines = partitionCustomerFacingLineItems(order.extendedLineItems).customerFacing;
      const items: FacilityItemRestriction[] = customerFacingLines.map((line) => {
        const format = detectBookFormat(line.title, line.variantTitle);
        const override = findCatalogInventoryOverride(line.title);

        if (approval.status === 'not_approved') {
          return {
            title: line.title,
            sku: line.sku,
            status: 'not_accepted' as const,
            reason: 'Facility is not approved for SureShot Books shipments.',
          };
        }

        if (rules && !rules.accepts_hardcover && format === 'hardcover') {
          return {
            title: line.title,
            sku: line.sku,
            status: 'not_accepted' as const,
            reason: 'Hardcover books are not accepted at this facility.',
          };
        }

        const restrictedCat = rules
          ? matchesRestrictedCategory(line.title, rules.restricted_categories)
          : null;
        if (restrictedCat) {
          return {
            title: line.title,
            sku: line.sku,
            status: approval.status === 'restricted' ? 'needs_review' : 'not_accepted',
            reason: `Title may fall under restricted category: ${restrictedCat}.`,
          };
        }

        if (override?.status === 'out_of_stock') {
          return {
            title: line.title,
            sku: line.sku,
            status: 'needs_review' as const,
            reason: 'Item is currently not in stock — staff review required.',
          };
        }

        return {
          title: line.title,
          sku: line.sku,
          status: 'accepted' as const,
          reason: 'Accepted by facility rules.',
        };
      });

      const restricted = items.filter((i) => i.status !== 'accepted');

      let suggested: string;
      if (!restricted.length) {
        suggested = `All books on order ${order.orderNumber} appear acceptable for ${approval.facility_name ?? facilityName}.`;
      } else if (restricted.length === 1) {
        const item = restricted[0];
        suggested = `One book on your order, "${item.title}", may not be accepted by the facility: ${item.reason} I will connect you with customer service to review options.`;
      } else {
        suggested = `${restricted.length} books on order ${order.orderNumber} may not be accepted by the facility. Customer service can review each title with you.`;
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.facility.restrictions_checked',
          orderNumber: order.orderNumber,
          restrictedCount: restricted.length,
          callSid: args.callSid ?? null,
        }),
      );

      return {
        success: true,
        order_number: order.orderNumber,
        facility_name: approval.facility_name,
        facility_approval_status: approval.status,
        items,
        restricted_items: restricted,
        suggested_response: sanitizeCustomerFacingText(suggested),
        escalate: restricted.length > 0 || approval.escalate,
        escalation_reason:
          restricted.length > 0 ? 'restricted_book' : approval.escalation_reason,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        facility_name: args.facilityName ?? null,
        facility_approval_status: 'unknown',
        items: [],
        restricted_items: [],
        suggested_response:
          'I could not check facility restrictions right now. Customer service can assist.',
        error: message,
        escalate: true,
        escalation_reason: 'tool_failure',
      };
    }
  }
}
