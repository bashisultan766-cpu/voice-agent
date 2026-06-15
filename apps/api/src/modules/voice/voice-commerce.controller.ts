import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { VoiceApiKeyGuard } from './guards/voice-api-key.guard';
import {
  flattenElevenLabsToolBody,
  resolveCallSidFromToolBody,
  resolvePhoneNumberFromToolBody,
} from './utils/parse-elevenlabs-tool-body.util';
import { VoiceCatalogService } from './services/voice-catalog.service';
import { VoicePricingService } from './services/voice-pricing.service';
import { FacilityApprovalService } from './services/facility-approval.service';
import { FacilityRestrictionService } from './services/facility-restriction.service';
import { VoiceAddressUpdateService } from './services/voice-address-update.service';
import { VoiceCancellationService } from './services/voice-cancellation.service';
import { VoiceEscalationService } from './services/voice-escalation.service';
import { VoiceCallDiagnosticsService } from './services/voice-call-diagnostics.service';

class CatalogSearchBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  caller_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  call_sid?: string;
}

class CalculatePricingBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  order_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  shipping_method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  destination_zip?: string;
}

class FacilityApprovalBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  facility_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  city?: string;
}

class OrderFacilityRestrictionsBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  order_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  facility_name?: string;
}

class AddressUpdateBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  order_number?: string;
}

class CancelOrderBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  order_number?: string;
}

class EscalateBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  order_number?: string;
}

function pickString(flat: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = flat[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * SureShot Books commerce tools for ElevenLabs ConvAI.
 */
@Controller('voice')
export class VoiceCommerceController {
  constructor(
    private readonly catalog: VoiceCatalogService,
    private readonly pricing: VoicePricingService,
    private readonly facilityApproval: FacilityApprovalService,
    private readonly facilityRestrictions: FacilityRestrictionService,
    private readonly addressUpdate: VoiceAddressUpdateService,
    private readonly cancellation: VoiceCancellationService,
    private readonly escalation: VoiceEscalationService,
    private readonly diagnostics: VoiceCallDiagnosticsService,
  ) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('catalog-search')
  catalogSearch(@Body() body: CatalogSearchBodyDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const query = pickString(flat, ['query', 'title', 'isbn', 'sku', 'search']) ?? body.query;
    if (!query) throw new BadRequestException('query is required in parameters.');
    const callSid = resolveCallSidFromToolBody(body);
    return this.catalog.searchCatalog({
      query,
      callerPhone: resolvePhoneNumberFromToolBody(body),
      callSid,
      tenantId: pickString(flat, ['tenantId', 'tenant_id']),
      agentId: pickString(flat, ['agentId', 'agent_id']),
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('calculate-pricing')
  calculatePricing(@Body() body: CalculatePricingBodyDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const orderNumber = pickString(flat, ['order_number', 'orderNumber', 'order']);
    const callSid = resolveCallSidFromToolBody(body);
    return this.pricing.calculatePricing({
      orderNumber,
      shippingMethod: pickString(flat, ['shipping_method', 'shippingMethod']),
      destinationZip: pickString(flat, ['destination_zip', 'destinationZip', 'zip']),
      tenantId: pickString(flat, ['tenantId', 'tenant_id']),
      agentId: pickString(flat, ['agentId', 'agent_id']),
      callSid,
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('check-facility-approval')
  checkFacilityApproval(@Body() body: FacilityApprovalBodyDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const facilityName = pickString(flat, ['facility_name', 'facilityName', 'facility']);
    if (!facilityName) throw new BadRequestException('facility_name is required.');
    return this.facilityApproval.checkFacilityApproval({
      facilityName,
      state: pickString(flat, ['state', 'province']),
      city: pickString(flat, ['city']),
      callSid: resolveCallSidFromToolBody(body),
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('check-order-facility-restrictions')
  checkOrderFacilityRestrictions(@Body() body: OrderFacilityRestrictionsBodyDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const orderNumber = pickString(flat, ['order_number', 'orderNumber', 'order']);
    if (!orderNumber) throw new BadRequestException('order_number is required.');
    return this.facilityRestrictions.checkOrderFacilityRestrictions({
      orderNumber,
      facilityName: pickString(flat, ['facility_name', 'facilityName']),
      tenantId: pickString(flat, ['tenantId', 'tenant_id']),
      agentId: pickString(flat, ['agentId', 'agent_id']),
      callSid: resolveCallSidFromToolBody(body),
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('address-update-instructions')
  addressUpdateInstructions(@Body() body: AddressUpdateBodyDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const orderNumber = pickString(flat, ['order_number', 'orderNumber', 'order']);
    return this.addressUpdate.getAddressUpdateInstructions({
      orderNumber,
      callSid: resolveCallSidFromToolBody(body),
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('cancel-order-request')
  cancelOrderRequest(@Body() body: CancelOrderBodyDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const orderNumber = pickString(flat, ['order_number', 'orderNumber', 'order']);
    if (!orderNumber) throw new BadRequestException('order_number is required.');
    return this.cancellation.checkCancellationEligibility({
      orderNumber,
      tenantId: pickString(flat, ['tenantId', 'tenant_id']),
      agentId: pickString(flat, ['agentId', 'agent_id']),
      callSid: resolveCallSidFromToolBody(body),
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('escalate-to-customer-service')
  escalateToCustomerService(@Body() body: EscalateBodyDto & Record<string, unknown>) {
    const flat = flattenElevenLabsToolBody(body);
    const reason = pickString(flat, ['reason']) ?? 'customer_requests_human';
    const callSid = resolveCallSidFromToolBody(body);
    if (reason === 'call_cutoff' && callSid) {
      this.diagnostics.recordCustomerReportedCutoff(callSid);
    }
    return this.escalation.escalate({
      reason,
      summary: pickString(flat, ['summary', 'notes']),
      orderNumber: pickString(flat, ['order_number', 'orderNumber']),
      callerPhone: resolvePhoneNumberFromToolBody(body),
      callSid,
    });
  }

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Get('call-diagnostics/:callSid')
  getCallDiagnostics(@Param('callSid') callSid: string) {
    const snapshot = this.diagnostics.getDiagnostics(callSid);
    if (!snapshot) {
      throw new NotFoundException(`No diagnostics found for call ${callSid}.`);
    }
    return { success: true, diagnostics: snapshot };
  }
}
