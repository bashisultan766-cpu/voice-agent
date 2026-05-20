import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { AgentsService } from './agents.service';
import { ShopifyAgentService } from './shopify-agent.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UserId } from '../../common/decorators/user-id.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  cuidParamSchema,
  logsQuerySchema,
  testAiBehaviorBodySchema,
  testDatabaseCredentialsSchema,
  testElevenLabsCredentialsSchema,
  testOpenAiCredentialsSchema,
  testShopifyCredentialsSchema,
  testTwilioCredentialsSchema,
  configureTwilioWebhookBodySchema,
  smokeTestBodySchema,
  debugShopifySearchBodySchema,
} from './agents-validation';
import { z } from 'zod';

/** Extract readable message from caught error (validation, etc.). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const r = (err as { getResponse?: () => unknown }).getResponse?.();
    if (r && typeof r === 'object' && r !== null) {
      const msg = (r as { message?: unknown }).message;
      if (Array.isArray(msg) && msg.length > 0 && typeof msg[0] === 'string') return msg[0];
      if (typeof msg === 'string') return msg;
    }
    return err.message;
  }
  return String(err);
}

@Controller('agents')
@Roles(UserRole.MANAGER)
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly shopifyAgent: ShopifyAgentService,
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post('test-credentials/shopify')
  async testShopifyCredentials(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(testShopifyCredentialsSchema))
    dto: z.infer<typeof testShopifyCredentialsSchema>,
  ) {
    try {
      return await this.agentsService.testShopifyConnection(tenantId, null, dto);
    } catch (err) {
      const message = errorMessage(err);
      return { success: false, message, code: 'INVALID_TOKEN_OR_DOMAIN' };
    }
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post('test-credentials/database')
  async testDatabaseCredentials(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(testDatabaseCredentialsSchema))
    dto: z.infer<typeof testDatabaseCredentialsSchema>,
  ) {
    try {
      return await this.agentsService.testDatabaseConnection(tenantId, null, dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Database connection test failed.';
      return { success: false, message };
    }
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post('test-credentials/twilio')
  async testTwilioCredentials(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(testTwilioCredentialsSchema))
    dto: z.infer<typeof testTwilioCredentialsSchema>,
  ) {
    try {
      return await this.agentsService.testTwilioConnection(tenantId, null, dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio connection test failed.';
      return { success: false, message };
    }
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post('test-credentials/openai')
  async testOpenAICredentials(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(testOpenAiCredentialsSchema))
    dto: z.infer<typeof testOpenAiCredentialsSchema>,
  ) {
    try {
      return await this.agentsService.testOpenAIConnection(tenantId, null, dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OpenAI connection test failed.';
      return { success: false, message };
    }
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post('test-credentials/elevenlabs')
  async testElevenLabsCredentials(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(testElevenLabsCredentialsSchema))
    dto: z.infer<typeof testElevenLabsCredentialsSchema>,
  ) {
    try {
      return await this.agentsService.testElevenLabsConnection(tenantId, null, dto);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ElevenLabs connection test failed.';
      return { success: false, message };
    }
  }

  @Roles(UserRole.MANAGER)
  @Post()
  create(@TenantId() tenantId: string, @UserId() userId: string, @Body() dto: CreateAgentDto) {
    return this.agentsService.create(tenantId, dto, userId);
  }

  @Roles(UserRole.SUPPORT)
  @Get()
  async findAll(@TenantId() tenantId: string) {
    try {
      return await this.agentsService.findAll(tenantId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('connect') || message.includes('Connection') || message.includes('ECONNREFUSED')) {
        throw new BadRequestException('Database is not available. Check that PostgreSQL is running and DATABASE_URL is set.');
      }
      if (message.includes('does not exist') || message.includes('relation') || message.includes('table') || message.includes('Unknown table')) {
        throw new BadRequestException('Database schema is missing. Run: pnpm db:migrate');
      }
      throw new InternalServerErrorException('Unable to load agents. Please try again or check the API logs.');
    }
  }

  @Roles(UserRole.SUPPORT)
  @Get(':id/analytics')
  getAnalytics(@TenantId() tenantId: string, @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string) {
    return this.agentsService.getAgentAnalytics(tenantId, id);
  }

  @Roles(UserRole.SUPPORT)
  @Get(':id/logs')
  getLogs(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Query(new ZodValidationPipe(logsQuerySchema)) query: z.infer<typeof logsQuerySchema>,
  ) {
    return this.agentsService.getAgentLogs(tenantId, id, query.limit ?? 50);
  }

  @Roles(UserRole.SUPPORT)
  @Get(':id/catalog-readiness')
  getCatalogReadiness(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.agentsService.getCatalogReadiness(tenantId, id);
  }

  @Roles(UserRole.SUPPORT)
  @Post(':id/test-ai')
  testAi(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(testAiBehaviorBodySchema)) dto: z.infer<typeof testAiBehaviorBodySchema>,
  ) {
    return this.agentsService.testAiBehavior(tenantId, id, dto?.sampleQuery ?? 'Where is my order?');
  }

  @Roles(UserRole.SUPPORT)
  @Get(':id')
  findOne(@TenantId() tenantId: string, @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string) {
    return this.agentsService.findOne(tenantId, id);
  }

  @Roles(UserRole.SUPPORT)
  @Get(':id/readiness')
  getReadiness(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.agentsService.getAgentReadiness(tenantId, id);
  }

  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @Post(':id/configure-twilio-webhook')
  configureTwilioWebhook(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(configureTwilioWebhookBodySchema))
    _dto: z.infer<typeof configureTwilioWebhookBodySchema>,
  ) {
    return this.agentsService.configureTwilioWebhook(tenantId, id);
  }

  @Roles(UserRole.MANAGER)
  @Post(':id/smoke-test')
  runSmokeTest(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(smokeTestBodySchema))
    dto: z.infer<typeof smokeTestBodySchema>,
  ) {
    return this.agentsService.runSmokeTest(tenantId, id, {
      sampleSpeechResult: dto.sampleSpeechResult,
    });
  }

  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @Post(':id/go-live')
  goLive(
    @TenantId() tenantId: string,
    @UserId() userId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.agentsService.goLive(tenantId, id, userId);
  }

  @Roles(UserRole.MANAGER)
  @Post(':id/sync-secrets-from-settings')
  syncSecretsFromSettings(
    @TenantId() tenantId: string,
    @UserId() userId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.agentsService.syncSecretsFromWorkspace(tenantId, id, userId);
  }

  @Roles(UserRole.MANAGER)
  @Patch(':id')
  update(
    @TenantId() tenantId: string,
    @UserId() userId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.agentsService.update(tenantId, id, dto, userId);
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(
    @TenantId() tenantId: string,
    @UserId() userId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
  ) {
    return this.agentsService.remove(tenantId, id, userId);
  }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post(':id/test-shopify')
  async testShopify(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(testShopifyCredentialsSchema))
    dto: z.infer<typeof testShopifyCredentialsSchema>,
  ) {
    try {
      return await this.agentsService.testShopifyConnection(tenantId, id, dto);
    } catch (err) {
      const message = errorMessage(err);
      return { success: false, message, code: 'INVALID_TOKEN_OR_DOMAIN' };
    }
  }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post(':id/test-database')
  testDatabase(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(testDatabaseCredentialsSchema))
    dto: z.infer<typeof testDatabaseCredentialsSchema>,
  ) {
    return this.agentsService.testDatabaseConnection(tenantId, id, dto);
  }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Roles(UserRole.ADMIN)
  @Post(':id/test-twilio')
  testTwilio(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(testTwilioCredentialsSchema))
    dto: z.infer<typeof testTwilioCredentialsSchema>,
  ) {
    return this.agentsService.testTwilioConnection(tenantId, id, dto);
  }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post(':id/test-openai')
  testOpenAI(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(testOpenAiCredentialsSchema))
    dto: z.infer<typeof testOpenAiCredentialsSchema>,
  ) {
    return this.agentsService.testOpenAIConnection(tenantId, id, dto);
  }

  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post(':id/test-elevenlabs')
  testElevenLabs(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(testElevenLabsCredentialsSchema))
    dto: z.infer<typeof testElevenLabsCredentialsSchema>,
  ) {
    return this.agentsService.testElevenLabsConnection(tenantId, id, dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Roles(UserRole.MANAGER)
  @Post(':id/debug-shopify-search')
  debugShopifySearch(
    @TenantId() tenantId: string,
    @Param('id', new ZodValidationPipe(cuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(debugShopifySearchBodySchema)) dto: z.infer<typeof debugShopifySearchBodySchema>,
  ) {
    return this.shopifyAgent.debugProductSearch(tenantId, id, dto.query);
  }
}
