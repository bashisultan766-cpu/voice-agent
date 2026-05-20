import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { PublicAgentsController } from './public-agents.controller';
import { AgentsService } from './agents.service';
import { ShopifyAgentService } from './shopify-agent.service';
import { ShopifyConnectionTestService } from './connection-test/shopify-connection-test.service';
import { DatabaseConnectionTestService } from './connection-test/database-connection-test.service';
import { TwilioConnectionTestService } from './connection-test/twilio-connection-test.service';
import { OpenAIConnectionTestService } from './connection-test/openai-connection-test.service';
import { ElevenLabsConnectionTestService } from './connection-test/elevenlabs-connection-test.service';
import { OrderBookingService } from './order-booking.service';
import { ShopifyProductSyncQueueService } from '../integrations/shopify/product-sync.queue';

@Module({
  controllers: [AgentsController, PublicAgentsController],
  providers: [
    AgentsService,
    ShopifyAgentService,
    ShopifyConnectionTestService,
    DatabaseConnectionTestService,
    TwilioConnectionTestService,
    OpenAIConnectionTestService,
    ElevenLabsConnectionTestService,
    OrderBookingService,
    ShopifyProductSyncQueueService,
  ],
  exports: [
    AgentsService,
    ShopifyAgentService,
    OrderBookingService,
    ShopifyConnectionTestService,
    TwilioConnectionTestService,
    OpenAIConnectionTestService,
    ElevenLabsConnectionTestService,
  ],
})
export class AgentsModule {}
