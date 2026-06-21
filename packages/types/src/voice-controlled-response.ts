/** Structured voice turn returned by the response controller. */
export type VoiceResponseAction =
  | 'order_lookup'
  | 'cancel_order'
  | 'refund'
  | 'escalate'
  | 'shipping_status'
  | 'payment_link'
  | 'product_search'
  | 'general';

export interface VoiceControlledResponseDto {
  text_response: string;
  action: VoiceResponseAction;
  voice_text: string;
}
