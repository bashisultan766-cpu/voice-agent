import { IsOptional, IsString, MaxLength } from 'class-validator';

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
};

export type GetOrderResponseDto = {
  success: boolean;
  found: boolean;
  order?: VoiceOrderDetailDto;
  voiceSummary?: string;
  error?: string;
  latencyMs?: number;
};
