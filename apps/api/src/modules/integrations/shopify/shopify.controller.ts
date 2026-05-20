import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { ShopifyService } from './shopify.service';
import { redactSecrets } from '../../../common/logging/safe-log';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('integrations/shopify')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Roles(UserRole.MANAGER)
export class ShopifyController {
  constructor(private readonly shopify: ShopifyService) {}
  private readonly logger = new Logger(ShopifyController.name);

  @Get('status')
  async status(
    @TenantId() tenantId: string,
    @Query('agentId') agentId: string,
  ) {
    if (!agentId?.trim()) throw new BadRequestException('agentId is required.');
    return this.shopify.getConnectionStatus(tenantId, agentId.trim());
  }

  @Get('health')
  async health(
    @TenantId() tenantId: string,
    @Query('agentId') agentId: string,
  ) {
    if (!agentId?.trim()) throw new BadRequestException('agentId is required.');
    return this.shopify.getWebhookHealth(tenantId, agentId.trim());
  }

  @Get('oauth/start')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async oauthStart(
    @TenantId() tenantId: string,
    @Query('agentId') agentId: string,
    @Query('shop') shop: string,
    @Res() res: Response,
  ) {
    if (!agentId?.trim()) throw new BadRequestException('agentId is required.');
    if (!shop?.trim()) throw new BadRequestException('shop is required (your-store.myshopify.com).');
    this.logger.log(`oauth.start tenant=${tenantId} agentId=${agentId.trim()} shop=${shop.trim().toLowerCase()}`);
    const installUrl = this.shopify.buildInstallUrl(tenantId, agentId.trim(), shop.trim());
    return res.redirect(installUrl);
  }

  @Post('disconnect')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  async disconnect(
    @TenantId() tenantId: string,
    @Body() body: { agentId?: string },
  ) {
    const agentId = body?.agentId?.trim();
    if (!agentId) throw new BadRequestException('agentId is required.');
    return this.shopify.disconnect(tenantId, agentId);
  }

  @Public()
  @SkipThrottle()
  @Get('oauth/callback')
  async oauthCallback(@Req() req: Request, @Res() res: Response) {
    const fullUrl = new URL(req.originalUrl, 'http://localhost');
    const result = await this.shopify.handleOAuthCallback(fullUrl.searchParams);
    this.logger.log('oauth.callback completed');
    return res.redirect(result.redirectUrl);
  }

  @Public()
  @SkipThrottle()
  @Post('webhooks')
  async webhooks(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('x-shopify-topic') topic: string,
    @Headers('x-shopify-shop-domain') shopDomain: string,
    @Headers('x-shopify-hmac-sha256') signature: string,
    @Body() parsedBody: unknown,
  ) {
    const topicSafe = topic ?? 'unknown';
    const domainSafe = (shopDomain ?? '').toLowerCase();
    try {
      const raw = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(JSON.stringify(parsedBody ?? {}), 'utf8');
      const valid = this.shopify.verifyWebhookSignature(raw, signature ?? '');
      if (!valid) {
        await this.shopify.recordWebhookFailure(topicSafe, domainSafe, 'Invalid Shopify webhook signature');
        this.logger.warn(
          `webhook signature invalid topic=${topicSafe} shop=${domainSafe} payload=${JSON.stringify(
            redactSecrets(parsedBody),
          ).slice(0, 500)}`,
        );
        throw new BadRequestException('Invalid Shopify webhook signature.');
      }

      let payload: unknown = parsedBody;
      if (Buffer.isBuffer(req.body)) {
        const rawText = req.body.toString('utf8');
        payload = rawText ? JSON.parse(rawText) : {};
      }

      await this.shopify.handleWebhook(topicSafe, domainSafe, payload);
      return res.status(200).send('ok');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown webhook processing error';
      await this.shopify.recordWebhookFailure(topicSafe, domainSafe, message, parsedBody).catch(() => undefined);
      this.logger.error(
        `webhook processing failed topic=${topicSafe} shop=${domainSafe} message=${message} payload=${JSON.stringify(
          redactSecrets(parsedBody),
        ).slice(0, 500)}`,
      );
      throw err;
    }
  }
}

