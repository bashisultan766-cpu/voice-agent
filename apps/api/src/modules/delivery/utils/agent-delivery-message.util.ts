export type DeliveryChannelResult = 'sent' | 'skipped' | 'failed';

export type PaymentLinkDeliveryResult = {
  email: DeliveryChannelResult;
  sms: DeliveryChannelResult;
  whatsapp: DeliveryChannelResult;
};

/**
 * Customer-facing phrase for the voice agent (no internal/provider names).
 */
export function buildAgentDeliveryMessage(result: PaymentLinkDeliveryResult): string {
  const emailOk = result.email === 'sent';
  const smsOk = result.sms === 'sent';
  const whatsappOk = result.whatsapp === 'sent';

  if (!emailOk) {
    return "I created your payment link, but I'm having trouble sending the email. Please confirm your email again.";
  }

  if (smsOk && whatsappOk) {
    return 'Perfect, I sent the payment link to your email, by text message, and on WhatsApp.';
  }

  if (whatsappOk) {
    return 'Perfect, I sent the payment link to your email and WhatsApp.';
  }

  if (smsOk) {
    return 'Perfect, I sent the payment link to your email and by text message.';
  }

  return 'Perfect, I sent the payment link to your email.';
}
