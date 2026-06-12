import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { VoiceApiKeyGuard } from '../../voice/guards/voice-api-key.guard';
import { CallerIdentityService } from './caller-identity.service';

/**
 * Import 3CX contact export (CSV text or JSON contacts array).
 * POST /api/integrations/3cx/contacts/import
 */
@Controller('integrations/3cx/contacts')
export class CallerIdentityAdminController {
  constructor(private readonly callerIdentity: CallerIdentityService) {}

  @Public()
  @SkipThrottle()
  @UseGuards(VoiceApiKeyGuard)
  @Post('import')
  importContacts(@Body() body: { csv?: string; contacts?: unknown; tenantId?: string }) {
    return this.callerIdentity.importThreeCxContacts(
      { csv: body.csv, contacts: body.contacts },
      { tenantId: body.tenantId },
    );
  }
}
