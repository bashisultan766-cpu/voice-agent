import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { VoiceOrderLookupService } from './voice-order-lookup.service';
import { maskTrackingNumber, sanitizeCustomerFacingText } from '../utils/voice-agent-language.util';

export type ShippingMethodLabel =
  | 'Media Mail'
  | 'Priority Mail'
  | 'UPS'
  | 'FedEx'
  | 'Other'
  | 'Not shipped yet';

export type ShippingInfoResult = {
  success: boolean;
  order_number?: string;
  shipping_method: ShippingMethodLabel;
  carrier: string | null;
  shipped_at: string | null;
  tracking_number_masked_or_allowed: string | null;
  tracking_url_if_allowed: string | null;
  delivery_status: string | null;
  shipping_cost: string | null;
  suggested_response: string;
  error?: string;
};

export function normalizeShippingMethod(
  title: string | null | undefined,
  carrier: string | null | undefined,
): ShippingMethodLabel {
  const combined = `${title ?? ''} ${carrier ?? ''}`.toLowerCase();
  if (!combined.trim() || combined.includes('not shipped')) return 'Not shipped yet';
  if (combined.includes('media mail') || combined.includes('media-mail')) return 'Media Mail';
  if (combined.includes('priority mail') || combined.includes('priority')) return 'Priority Mail';
  if (combined.includes('ups')) return 'UPS';
  if (combined.includes('fedex') || combined.includes('fed ex')) return 'FedEx';
  if (title?.trim()) return 'Other';
  return 'Not shipped yet';
}

@Injectable()
export class VoiceShippingService {
  private readonly logger = new Logger(VoiceShippingService.name);

  constructor(private readonly orderLookup: VoiceOrderLookupService) {}

  async getOrderShipping(args: {
    orderNumber: string;
    tenantId?: string;
    agentId?: string;
    callSid?: string;
    allowFullTracking?: boolean;
  }): Promise<ShippingInfoResult> {
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
          shipping_method: 'Not shipped yet',
          carrier: null,
          shipped_at: null,
          tracking_number_masked_or_allowed: null,
          tracking_url_if_allowed: null,
          delivery_status: null,
          shipping_cost: null,
          suggested_response: 'I could not find that order to check shipping status.',
          error: 'order_not_found',
        };
      }

      const fulfillment = order.fulfillments[0];
      const tracking = fulfillment?.tracking?.find((t) => t.number) ?? null;
      const shippingMethod = order.isShipped
        ? normalizeShippingMethod(order.shippingMethodTitle, tracking?.company ?? order.shippingCarrier)
        : 'Not shipped yet';

      const shippedAt =
        fulfillment?.inTransitAt ?? fulfillment?.estimatedDeliveryAt ?? order.createdAt ?? null;

      const trackingMasked = args.allowFullTracking
        ? tracking?.number ?? null
        : maskTrackingNumber(tracking?.number);

      const deliveryStatus =
        fulfillment?.deliveredAt
          ? 'delivered'
          : fulfillment?.inTransitAt
            ? 'in_transit'
            : order.isShipped
              ? 'shipped'
              : 'not_shipped';

      let suggested: string;
      if (!order.isShipped) {
        suggested = `Order ${order.orderNumber} has not shipped yet. Fulfillment status is ${order.fulfillmentStatus ?? 'pending'}.`;
      } else {
        suggested = `Order ${order.orderNumber} shipped via ${shippingMethod}.`;
        if (trackingMasked) {
          suggested += ` Tracking number ending in ${trackingMasked.replace(/\*/g, '')}.`;
        }
        if (fulfillment?.estimatedDeliveryAt) {
          const eta = new Date(fulfillment.estimatedDeliveryAt).toLocaleDateString('en-US');
          suggested += ` Estimated delivery is ${eta}.`;
        }
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.shipping.lookup',
          orderNumber: order.orderNumber,
          shippingMethod,
          deliveryStatus,
          callSid: args.callSid ?? null,
        }),
      );

      return {
        success: true,
        order_number: order.orderNumber,
        shipping_method: shippingMethod,
        carrier: tracking?.company ?? order.shippingCarrier,
        shipped_at: shippedAt,
        tracking_number_masked_or_allowed: trackingMasked,
        tracking_url_if_allowed: args.allowFullTracking ? tracking?.url ?? null : null,
        delivery_status: deliveryStatus,
        shipping_cost: order.shippingCost,
        suggested_response: sanitizeCustomerFacingText(suggested),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'tool_failed',
          tool: 'shipping-lookup',
          message: message.slice(0, 400),
          callSid: args.callSid ?? null,
        }),
      );
      return {
        success: false,
        shipping_method: 'Not shipped yet',
        carrier: null,
        shipped_at: null,
        tracking_number_masked_or_allowed: null,
        tracking_url_if_allowed: null,
        delivery_status: null,
        shipping_cost: null,
        suggested_response:
          'I could not retrieve shipping details right now. Customer service can help with tracking.',
        error: message,
      };
    }
  }
}
