import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { VoiceOrderLookupService } from './voice-order-lookup.service';
import { sanitizeCustomerFacingText } from '../utils/voice-agent-language.util';

export type CancellationResult = {
  success: boolean;
  order_number?: string;
  cancellation_eligible: boolean;
  reason: string;
  next_step: string;
  order_status?: string;
  fulfillment_status?: string | null;
  suggested_response: string;
  escalate?: boolean;
  error?: string;
};

@Injectable()
export class VoiceCancellationService {
  private readonly logger = new Logger(VoiceCancellationService.name);

  constructor(private readonly orderLookup: VoiceOrderLookupService) {}

  async checkCancellationEligibility(args: {
    orderNumber: string;
    tenantId?: string;
    agentId?: string;
    callSid?: string;
  }): Promise<CancellationResult> {
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
          cancellation_eligible: false,
          reason: 'Order not found.',
          next_step: 'Verify the order number with the customer.',
          suggested_response:
            'I could not find that order. Please verify the order number on your confirmation email.',
          error: 'order_not_found',
        };
      }

      if (order.isCancelled) {
        return {
          success: true,
          order_number: order.orderNumber,
          cancellation_eligible: false,
          reason: 'Order is already cancelled.',
          next_step: 'Explain current cancelled status to the customer.',
          order_status: 'cancelled',
          fulfillment_status: order.fulfillmentStatus,
          suggested_response: sanitizeCustomerFacingText(
            `Order ${order.orderNumber} has already been cancelled.${order.cancelReason ? ` Reason: ${order.cancelReason}.` : ''}`,
          ),
        };
      }

      if (order.isRefunded) {
        return {
          success: true,
          order_number: order.orderNumber,
          cancellation_eligible: false,
          reason: 'Order has been refunded.',
          next_step: 'Explain refund status to the customer.',
          order_status: order.orderStatus,
          fulfillment_status: order.fulfillmentStatus,
          suggested_response: sanitizeCustomerFacingText(
            `Order ${order.orderNumber} has a refund on file. Payment status is ${order.financialStatus ?? 'refunded'}.`,
          ),
        };
      }

      if (order.isShipped) {
        return {
          success: true,
          order_number: order.orderNumber,
          cancellation_eligible: false,
          reason: 'Order has already shipped and cannot be cancelled by phone.',
          next_step: 'Escalate to customer service for return options if applicable.',
          order_status: 'shipped',
          fulfillment_status: order.fulfillmentStatus,
          suggested_response: sanitizeCustomerFacingText(
            `Order ${order.orderNumber} has already shipped, so it cannot be cancelled. I can connect you with customer service to discuss return options.`,
          ),
          escalate: true,
        };
      }

      const fulfilled =
        order.fulfillmentStatus?.toUpperCase() === 'FULFILLED' ||
        order.fulfillmentStatus?.toUpperCase() === 'PARTIALLY_FULFILLED';

      if (fulfilled) {
        return {
          success: true,
          order_number: order.orderNumber,
          cancellation_eligible: false,
          reason: 'Order fulfillment has started.',
          next_step: 'Escalate to customer service for cancellation review.',
          order_status: order.orderStatus,
          fulfillment_status: order.fulfillmentStatus,
          suggested_response: sanitizeCustomerFacingText(
            `Order ${order.orderNumber} is already being fulfilled and may not be cancellable. I will connect you with customer service.`,
          ),
          escalate: true,
        };
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.cancellation.eligible',
          orderNumber: order.orderNumber,
          callSid: args.callSid ?? null,
        }),
      );

      return {
        success: true,
        order_number: order.orderNumber,
        cancellation_eligible: true,
        reason: 'Order is not shipped or fulfilled.',
        next_step: 'Submit cancellation request to customer service for processing.',
        order_status: order.orderStatus,
        fulfillment_status: order.fulfillmentStatus,
        suggested_response: sanitizeCustomerFacingText(
          `Order ${order.orderNumber} has not shipped yet. I can submit a cancellation request to our customer service team for you.`,
        ),
        escalate: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        cancellation_eligible: false,
        reason: 'Could not verify order status.',
        next_step: 'Escalate to customer service.',
        suggested_response:
          'I could not verify cancellation eligibility right now. Customer service can help.',
        error: message,
        escalate: true,
      };
    }
  }
}
