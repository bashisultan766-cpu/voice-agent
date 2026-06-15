import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type {
  GetOrderResponseDto,
  VoiceOrderEnrichedFields,
} from './dto/get-order.dto';
import {
  applyPrivacyToOrder,
  buildMaskedOrderFields,
  buildPrivacyAwareVoiceOrderSummary,
  buildRefundOrderSummary,
  resolveVerificationFlags,
} from './utils/voice-order-privacy.util';
import { VoiceOrderLookupService } from './services/voice-order-lookup.service';
import { VoiceCancellationService } from './services/voice-cancellation.service';
import { FacilityRestrictionService } from './services/facility-restriction.service';
import {
  buildEnrichedOrderVoiceSummary,
  classifyOrderLineItems,
  resolveOrderShippingMethodLabel,
} from './utils/voice-order-enrichment.util';
import { SUBTOTAL_DISCLAIMER, maskTrackingNumber, sanitizeCustomerFacingText } from './utils/voice-agent-language.util';
import {
  isHiddenInternalLineItem,
  partitionCustomerFacingLineItems,
  sanitizeVoiceCommerceResponse,
} from './utils/sanitize-voice-commerce-response.util';

@Injectable()
export class VoiceOrderService {
  private readonly logger = new Logger(VoiceOrderService.name);

  constructor(
    private readonly orderLookup: VoiceOrderLookupService,
    private readonly cancellation: VoiceCancellationService,
    private readonly facilityRestrictions: FacilityRestrictionService,
  ) {}

  async getOrder(args: {
    orderNumber: string;
    tenantId?: string;
    agentId?: string;
    callerPhone?: string;
  }): Promise<GetOrderResponseDto> {
    const started = Date.now();
    const orderNumber = args.orderNumber.trim();
    if (!orderNumber) {
      throw new BadRequestException('order_number is required.');
    }

    this.logger.log(
      JSON.stringify({
        event: 'order_lookup_started',
        orderNumber: orderNumber.slice(0, 32),
        callerPhoneMasked: args.callerPhone ? maskCallerPhone(args.callerPhone) : null,
      }),
    );

    try {
      const order = await this.orderLookup.lookupOrder({
        orderNumber,
        tenantId: args.tenantId,
        agentId: args.agentId,
      });

      const latencyMs = Date.now() - started;

      if (!order) {
        const notFoundSummary = `No order found with number ${orderNumber}. Ask the caller to verify the order number on their confirmation email.`;
        this.logger.log(
          JSON.stringify({
            event: 'voice.order.not_found',
            orderNumber: orderNumber.slice(0, 32),
            latencyMs,
          }),
        );
        return sanitizeVoiceCommerceResponse({
          success: true,
          found: false,
          voiceSummary: notFoundSummary,
          suggested_response: notFoundSummary,
          latencyMs,
        });
      }

      const verification = resolveVerificationFlags({
        callerPhone: args.callerPhone,
        customerPhone: order.customerPhone,
        orderFound: true,
      });
      const { customerFacing: customerFacingLineItems, hiddenCount: hiddenInternalItemsCount } =
        partitionCustomerFacingLineItems(order.lineItems);
      const { customerFacing: customerFacingExtendedLineItems } = partitionCustomerFacingLineItems(
        order.extendedLineItems,
      );
      const customerOrder: typeof order = {
        ...order,
        lineItems: customerFacingLineItems,
        extendedLineItems: customerFacingExtendedLineItems,
      };

      const maskedFields = buildMaskedOrderFields(customerOrder, verification);
      const privacyOrder = applyPrivacyToOrder(customerOrder, verification);
      const refundSummary = buildRefundOrderSummary(customerOrder, verification, maskedFields);

      const { backorder_items, out_of_stock_items } = classifyOrderLineItems(
        customerFacingExtendedLineItems,
        customerOrder,
      );

      const cancellation = await this.cancellation.checkCancellationEligibility({
        orderNumber: order.orderNumber,
        tenantId: args.tenantId,
        agentId: args.agentId,
      });

      const facilityCheck = await this.facilityRestrictions.checkOrderFacilityRestrictions({
        orderNumber: order.orderNumber,
        tenantId: args.tenantId,
        agentId: args.agentId,
      });

      const shippingMethod = resolveOrderShippingMethodLabel(customerOrder);
      const tracking = customerOrder.fulfillments[0]?.tracking?.find((t) => t.number);
      const allowFullTracking = verification.verified_level === 'full';

      const enriched: VoiceOrderEnrichedFields = {
        order_number: customerOrder.orderNumber,
        order_status: customerOrder.orderStatus,
        fulfillment_status: customerOrder.fulfillmentStatus,
        financial_status: customerOrder.financialStatus,
        refund_status: customerOrder.refundStatus,
        subtotal_without_shipping: order.subtotalWithoutShipping,
        shipping_cost: order.shippingCost,
        subtotal_disclaimer: SUBTOTAL_DISCLAIMER,
        shipping_method: shippingMethod,
        carrier: tracking?.company ?? customerOrder.shippingCarrier,
        tracking_status: customerOrder.isShipped ? 'shipped' : 'not_shipped',
        tracking_number_masked: allowFullTracking
          ? tracking?.number ?? null
          : maskTrackingNumber(tracking?.number),
        items: customerFacingLineItems,
        customer_facing_items: customerFacingLineItems,
        hidden_internal_items_count: hiddenInternalItemsCount,
        backorder_items,
        out_of_stock_items,
        facility_restricted_items: facilityCheck.restricted_items
          .filter((i) => !isHiddenInternalLineItem(i.title))
          .map((i) => ({
            title: i.title,
            sku: i.sku,
            status: i.status,
            reason: i.reason,
          })),
        cancellation_eligible: cancellation.cancellation_eligible,
        cancellation_reason: cancellation.reason,
        cancellation_next_step: cancellation.next_step,
      };

      const baseSummary = buildPrivacyAwareVoiceOrderSummary(customerOrder, verification, maskedFields);
      const enrichedSummary = buildEnrichedOrderVoiceSummary({
        order: customerOrder,
        backorderItems: backorder_items,
        outOfStockItems: out_of_stock_items,
        cancellationEligible: cancellation.cancellation_eligible,
        shippingMethod,
      });
      const voiceSummary = sanitizeCustomerFacingText(`${baseSummary} ${enrichedSummary}`);

      this.logger.log(
        JSON.stringify({
          event: 'order_lookup_success',
          orderNumber: order.orderNumber,
          verifiedLevel: verification.verified_level,
          phoneMatchesCustomer: verification.phone_matches_customer,
          latencyMs,
        }),
      );

      if (refundSummary) {
        this.logger.log(
          JSON.stringify({
            event: 'refund_lookup_success',
            orderNumber: order.orderNumber,
            refundStatus: refundSummary.refund_status,
            latencyMs,
          }),
        );
      }

      this.logger.log(
        JSON.stringify({
          event: 'privacy_mode_applied',
          orderNumber: order.orderNumber,
          verifiedLevel: verification.verified_level,
        }),
      );

      return sanitizeVoiceCommerceResponse({
        success: true,
        found: true,
        order: privacyOrder,
        enriched,
        verification,
        maskedFields,
        refundSummary: refundSummary ?? undefined,
        voiceSummary,
        suggested_response: voiceSummary,
        privacyModeApplied: true,
        customer_facing_items: customerFacingLineItems,
        hidden_internal_items_count: hiddenInternalItemsCount,
        subtotal_without_shipping: order.subtotalWithoutShipping,
        shipping_cost: order.shippingCost,
        subtotal_disclaimer: SUBTOTAL_DISCLAIMER,
        latencyMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'voice.order.lookup_failed',
          message: message.slice(0, 400),
          latencyMs: Date.now() - started,
        }),
      );
      return sanitizeVoiceCommerceResponse({
        success: false,
        found: false,
        error: message,
        voiceSummary:
          'I could not look up that order right now. Apologize briefly and offer to try again or connect the caller with support.',
        suggested_response:
          'I could not look up that order right now. I will connect you with customer service.',
        latencyMs: Date.now() - started,
      });
    }
  }
}

function maskCallerPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}
