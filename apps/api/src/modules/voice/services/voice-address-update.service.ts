import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sanitizeCustomerFacingText } from '../utils/voice-agent-language.util';

export type AddressUpdateInstructionsResult = {
  success: boolean;
  order_number: string | null;
  support_email: string;
  instructions: string;
  suggested_response: string;
};

@Injectable()
export class VoiceAddressUpdateService {
  constructor(private readonly config: ConfigService) {}

  getAddressUpdateInstructions(args: {
    orderNumber?: string;
    callSid?: string;
  }): AddressUpdateInstructionsResult {
    const orderNumber = args.orderNumber?.trim() || null;
    if (!orderNumber) {
      throw new BadRequestException('order_number is required.');
    }

    const supportEmail = this.resolveSupportEmail();
    const instructions = `Please email ${supportEmail} with your order number and the correct shipping address.`;
    const suggested = sanitizeCustomerFacingText(
      `To update the shipping address for order ${orderNumber}, please email Jessica at ${supportEmail} with your order number and the correct address. Our team will update it for you.`,
    );

    return {
      success: true,
      order_number: orderNumber,
      support_email: supportEmail,
      instructions,
      suggested_response: suggested,
    };
  }

  resolveSupportEmail(): string {
    return (
      this.config.get<string>('JESSICA_SUPPORT_EMAIL')?.trim() ||
      this.config.get<string>('CUSTOMER_SERVICE_EMAIL')?.trim() ||
      this.config.get<string>('VOICE_COMMERCE_SUPPORT_EMAIL')?.trim() ||
      'support@sureshotbooks.com'
    );
  }
}
