import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SendPaymentLinkDto } from './dto/send-payment-link.dto';
import { VoicePaymentService } from './voice-payment.service';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import { resolveSendPaymentLinkFieldsFromToolBody } from './utils/parse-elevenlabs-tool-body.util';
import { resolvePaymentEmailConfirmed } from './utils/resolve-payment-email-confirmed.util';
import { isUsableShopifyVariantId } from './utils/resolve-payment-variant.util';

/**
 * Voice checkout — draft order invoice for ElevenLabs server tools.
 * POST /api/voice/send-payment-link
 *
 * Accepts flat JSON or ElevenLabs `{ parameters: { ... } }` tool payloads.
 */
@Controller('voice')
export class VoicePaymentController {
  constructor(private readonly voicePayment: VoicePaymentService) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('send-payment-link')
  sendPaymentLink(@Body() body: SendPaymentLinkDto & Record<string, unknown>) {
    const fromTool = resolveSendPaymentLinkFieldsFromToolBody(body);

    const email = (fromTool.email ?? body.email)?.trim();
    const variantId = (fromTool.variantId ?? body.variantId)?.trim();
    const productName = (
      fromTool.productName ??
      body.productName ??
      body.productQuery ??
      (typeof body.query === 'string' ? body.query : undefined)
    )?.trim();
    const quantity = fromTool.quantity ?? body.quantity;
    const phoneNumber =
      fromTool.phoneNumber?.trim() || body.phoneNumber?.trim() || body.phone?.trim();
    const callSid =
      fromTool.callSid?.trim() || body.callSid?.trim() || body.call_sid?.trim();

    const finalizeRequested =
      fromTool.finalizeCheckout === true || body.finalizeCheckout === true;

    if (!finalizeRequested) {
      if (quantity == null) {
        throw new BadRequestException('quantity is required.');
      }
      if (!variantId && !productName) {
        throw new BadRequestException(
          'variantId or productName is required (productName triggers automatic catalog search).',
        );
      }
    } else if (quantity == null && (variantId || productName)) {
      throw new BadRequestException('quantity is required when adding a product.');
    }

    let effectiveVariantId = variantId || undefined;
    if (effectiveVariantId && !isUsableShopifyVariantId(effectiveVariantId)) {
      if (!productName) {
        throw new BadRequestException(
          'Invalid variantId (often 0 or a placeholder). Send productName with the book title instead.',
        );
      }
      effectiveVariantId = undefined;
    }
    if (!email && !callSid) {
      throw new BadRequestException(
        'email is required, or callSid with a confirmed session email.',
      );
    }

    const emailConfirmed = resolvePaymentEmailConfirmed({
      fromTool: fromTool.emailConfirmed,
      body,
      callSid,
    });

    return this.voicePayment.sendPaymentLink({
      email: email ?? '',
      variantId: effectiveVariantId,
      productName: productName || undefined,
      quantity: quantity ?? 1,
      phoneNumber,
      callSid,
      tenantId: fromTool.tenantId ?? body.tenantId,
      agentId: fromTool.agentId ?? body.agentId,
      emailConfirmed,
      finalizeCheckout: fromTool.finalizeCheckout ?? body.finalizeCheckout,
    });
  }
}
