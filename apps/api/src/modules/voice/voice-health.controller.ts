import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { resolveRedisUrlFromConfig } from '../../common/redis-client.util';
import { PrismaService } from '../../database/prisma.service';

@Public()
@Controller('voice/health')
export class VoiceHealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async check() {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    const redisUrl = resolveRedisUrlFromConfig((k) => this.config.get<string>(k));
    checks.redis = redisUrl ? 'configured' : 'not_configured';

    const shopifyDefault =
      Boolean(this.config.get<string>('VOICE_DEFAULT_AGENT_ID')?.trim()) ||
      Boolean(this.config.get<string>('SHOPIFY_ADMIN_API_TOKEN')?.trim());
    checks.shopify = shopifyDefault ? 'configured' : 'agent_credentials_required';

    const ok = checks.database === 'ok';
    return {
      status: ok ? 'ok' : 'degraded',
      service: 'voice-commerce',
      checks,
    };
  }
}
