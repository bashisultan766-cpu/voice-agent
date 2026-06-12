import { Controller, Get, Logger, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { ThreeCxCallerService } from './three-cx-caller.service';

/**
 * 3CX CRM integration URL template:
 * GET /api/integrations/3cx/crm/lookup?phone=[Number]
 *
 * Configure in 3CX Management Console → CRM → Integration.
 * Optional: set THREE_CX_CRM_TOKEN and pass ?token=... on the URL.
 */
@Controller('integrations/3cx/crm')
export class ThreeCxCrmController {
  private readonly logger = new Logger(ThreeCxCrmController.name);

  constructor(
    private readonly threeCxCaller: ThreeCxCallerService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get('lookup')
  async lookup(@Query('phone') phone?: string, @Query('token') token?: string) {
    const expectedToken = this.config.get<string>('THREE_CX_CRM_TOKEN')?.trim();
    if (expectedToken && token?.trim() !== expectedToken) {
      throw new UnauthorizedException('Invalid 3CX CRM token.');
    }

    const rawPhone = (phone ?? '').trim();
    this.logger.log(
      JSON.stringify({
        event: 'three_cx.crm_lookup',
        hasPhone: Boolean(rawPhone),
        phoneMasked: rawPhone ? `***${rawPhone.replace(/\D/g, '').slice(-4)}` : null,
      }),
    );

    const info = await this.threeCxCaller.getCallerInfo(rawPhone);
    return {
      FirstName: info.first_name ?? '',
      LastName: info.last_name ?? '',
      CompanyName: info.company ?? '',
      Email: info.email ?? '',
      ContactID: info.contact_id ?? '',
      PhoneBusiness: info.phone_number,
      CallCount: info.call_count,
      LastCallDate: info.last_call_date ?? '',
    };
  }
}
