import { IsOptional, IsString, MaxLength } from 'class-validator';
import type {
  MaskedOrderFields,
  VoiceOrderRefundSummary,
  VoiceOrderVerificationFlags,
} from '../utils/voice-order-privacy.util';
import type { PrivacySafeOrderDto } from '../utils/voice-order-privacy.util';

/** GET /api/voice/get-order — ElevenLabs GetOrders tool */
export class GetOrderQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  order_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  order?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  caller_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  callerPhone?: string;
}

export type VoiceOrderLineItemDto = {
  title: string;
  quantity: number;
  sku: string | null;
  variantTitle: string | null;
};

export type VoiceOrderTrackingDto = {
  company: string | null;
  number: string | null;
  url: string | null;
};

export type VoiceOrderFulfillmentDto = {
  status: string | null;
  displayStatus: string | null;
  tracking: VoiceOrderTrackingDto[];
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  inTransitAt: string | null;
};

export type VoiceOrderAddressDto = {
  name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  provinceCode: string | null;
  zip: string | null;
  countryCode: string | null;
};

export type VoiceOrderRefundDto = {
  createdAt: string;
  amount: string | null;
  currency: string | null;
  note: string | null;
};

export type VoiceOrderDetailDto = {
  id: string;
  orderNumber: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  totalPrice: string | null;
  currency: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  shippingAddress: VoiceOrderAddressDto | null;
  lineItems: VoiceOrderLineItemDto[];
  fulfillments: VoiceOrderFulfillmentDto[];
  refunds: VoiceOrderRefundDto[];
  /** Last 4 digits of the payment card (never the full number). */
  paymentCardLast4: string | null;
  paymentCardBrand: string | null;
};

export type VoiceOrderItemStatusDto = {
  title: string;
  sku: string | null;
  quantity?: number;
  status?: string;
  reason?: string;
};

export type VoiceOrderEnrichedFields = {
  order_number: string;
  order_status: string;
  fulfillment_status: string | null;
  financial_status: string | null;
  refund_status: string | null;
  subtotal_without_shipping: string | null;
  shipping_cost: string | null;
  subtotal_disclaimer: string;
  shipping_method: string;
  carrier: string | null;
  tracking_status: string;
  tracking_number_masked?: string | null;
  items: VoiceOrderLineItemDto[];
  backorder_items: VoiceOrderItemStatusDto[];
  out_of_stock_items: VoiceOrderItemStatusDto[];
  facility_restricted_items: VoiceOrderItemStatusDto[];
  cancellation_eligible: boolean;
  cancellation_reason?: string;
  cancellation_next_step?: string;
  customer_facing_items: VoiceOrderLineItemDto[];
  hidden_internal_items_count: number;
};

export type GetOrderResponseDto = {
  success: boolean;
  found: boolean;
  order?: PrivacySafeOrderDto;
  enriched?: VoiceOrderEnrichedFields;
  voiceSummary?: string;
  suggested_response?: string;
  error?: string;
  latencyMs?: number;
  verification?: VoiceOrderVerificationFlags;
  maskedFields?: MaskedOrderFields;
  refundSummary?: VoiceOrderRefundSummary;
  privacyModeApplied?: boolean;
  customer_facing_items?: VoiceOrderLineItemDto[];
  hidden_internal_items_count?: number;
  subtotal_without_shipping?: string | null;
  shipping_cost?: string | null;
  subtotal_disclaimer?: string;
};
