import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { VoiceOrderLookupService } from './voice-order-lookup.service';
import {
  SUBTOTAL_DISCLAIMER,
  buildSubtotalSpokenLine,
  formatMoney,
  sanitizeCustomerFacingText,
} from '../utils/voice-agent-language.util';

export type ShippingMethodOption = {
  method: string;
  estimated_cost: string | null;
  description: string;
};

export type PricingResult = {
  success: boolean;
  order_number?: string;
  subtotal_without_shipping: string | null;
  shipping_cost: string | null;
  shipping_method_options: ShippingMethodOption[];
  estimated_total: string | null;
  subtotal_disclaimer: string;
  shipping_status: 'calculated' | 'needs_address_or_method' | 'subtotal_only';
  currency: string;
  suggested_response: string;
  error?: string;
};

const DEFAULT_SHIPPING_OPTIONS: ShippingMethodOption[] = [
  {
    method: 'Media Mail',
    estimated_cost: null,
    description: 'Economy USPS shipping for books — typically 5–10 business days.',
  },
  {
    method: 'Priority Mail',
    estimated_cost: null,
    description: 'Faster USPS shipping — typically 2–3 business days.',
  },
];

@Injectable()
export class VoicePricingService {
  private readonly logger = new Logger(VoicePricingService.name);

  constructor(private readonly orderLookup: VoiceOrderLookupService) {}

  async calculatePricing(args: {
    orderNumber?: string;
    shippingMethod?: string;
    destinationZip?: string;
    tenantId?: string;
    agentId?: string;
    callSid?: string;
  }): Promise<PricingResult> {
    const orderNumber = args.orderNumber?.trim();
    if (!orderNumber) {
      throw new BadRequestException('order_number is required for pricing.');
    }

    try {
      const order = await this.orderLookup.lookupOrder({
        orderNumber,
        tenantId: args.tenantId,
        agentId: args.agentId,
      });

      if (!order) {
        return {
          success: false,
          subtotal_without_shipping: null,
          shipping_cost: null,
          shipping_method_options: DEFAULT_SHIPPING_OPTIONS,
          estimated_total: null,
          subtotal_disclaimer: SUBTOTAL_DISCLAIMER,
          shipping_status: 'needs_address_or_method',
          currency: 'USD',
          suggested_response:
            'I could not find that order to calculate pricing. Please verify the order number.',
          error: 'order_not_found',
        };
      }

      const currency = order.currency ?? 'USD';
      const subtotal = order.subtotalWithoutShipping;
      const hasShippingOnOrder = order.shippingCost != null && Number(order.shippingCost) > 0;
      const hasAddress = Boolean(order.shippingAddress?.zip);
      const requestedMethod = args.shippingMethod?.trim();

      let shippingCost = order.shippingCost;
      let shippingStatus: PricingResult['shipping_status'] = 'subtotal_only';
      let estimatedTotal: string | null = order.totalPrice;

      if (hasShippingOnOrder) {
        shippingStatus = 'calculated';
      } else if (requestedMethod && (hasAddress || args.destinationZip)) {
        shippingStatus = 'needs_address_or_method';
        shippingCost = null;
        estimatedTotal = subtotal;
      } else if (!hasAddress && !args.destinationZip) {
        shippingStatus = 'needs_address_or_method';
        shippingCost = null;
        estimatedTotal = subtotal;
      }

      const methodOptions = DEFAULT_SHIPPING_OPTIONS.map((opt) => ({
        ...opt,
        estimated_cost:
          opt.method.toLowerCase() === requestedMethod?.toLowerCase() && shippingCost
            ? formatMoney(shippingCost, currency)
            : opt.estimated_cost,
      }));

      const suggestedParts: string[] = [];
      if (subtotal) {
        suggestedParts.push(buildSubtotalSpokenLine(subtotal, currency));
      }
      if (shippingStatus === 'calculated' && shippingCost) {
        suggestedParts.push(
          sanitizeCustomerFacingText(
            `Shipping is ${formatMoney(shippingCost, currency)}${order.shippingMethodTitle ? ` via ${order.shippingMethodTitle}` : ''}.`,
          ),
        );
      } else if (shippingStatus === 'needs_address_or_method') {
        suggestedParts.push(
          'Shipping cost depends on your destination and shipping method. I can share the subtotal before shipping now.',
        );
      }
      if (estimatedTotal && shippingStatus === 'calculated') {
        suggestedParts.push(
          sanitizeCustomerFacingText(
            `The estimated order total is ${formatMoney(estimatedTotal, currency)}.`,
          ),
        );
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.pricing.calculated',
          orderNumber: order.orderNumber,
          shippingStatus,
          callSid: args.callSid ?? null,
        }),
      );

      return {
        success: true,
        order_number: order.orderNumber,
        subtotal_without_shipping: subtotal,
        shipping_cost: shippingCost,
        shipping_method_options: methodOptions,
        estimated_total: estimatedTotal,
        subtotal_disclaimer: SUBTOTAL_DISCLAIMER,
        shipping_status: shippingStatus,
        currency,
        suggested_response: suggestedParts.join(' '),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'tool_failed',
          tool: 'calculate-pricing',
          message: message.slice(0, 400),
          callSid: args.callSid ?? null,
        }),
      );
      return {
        success: false,
        subtotal_without_shipping: null,
        shipping_cost: null,
        shipping_method_options: DEFAULT_SHIPPING_OPTIONS,
        estimated_total: null,
        subtotal_disclaimer: SUBTOTAL_DISCLAIMER,
        shipping_status: 'needs_address_or_method',
        currency: 'USD',
        suggested_response:
          'I could not calculate pricing right now. Our customer service team can help with order totals.',
        error: message,
      };
    }
  }
}
