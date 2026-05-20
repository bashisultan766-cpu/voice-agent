"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentsModule = void 0;
const common_1 = require("@nestjs/common");
const agents_controller_1 = require("./agents.controller");
const public_agents_controller_1 = require("./public-agents.controller");
const agents_service_1 = require("./agents.service");
const shopify_agent_service_1 = require("./shopify-agent.service");
const shopify_connection_test_service_1 = require("./connection-test/shopify-connection-test.service");
const database_connection_test_service_1 = require("./connection-test/database-connection-test.service");
const twilio_connection_test_service_1 = require("./connection-test/twilio-connection-test.service");
const openai_connection_test_service_1 = require("./connection-test/openai-connection-test.service");
const elevenlabs_connection_test_service_1 = require("./connection-test/elevenlabs-connection-test.service");
const order_booking_service_1 = require("./order-booking.service");
const product_sync_queue_1 = require("../integrations/shopify/product-sync.queue");
let AgentsModule = class AgentsModule {
};
exports.AgentsModule = AgentsModule;
exports.AgentsModule = AgentsModule = __decorate([
    (0, common_1.Module)({
        controllers: [agents_controller_1.AgentsController, public_agents_controller_1.PublicAgentsController],
        providers: [
            agents_service_1.AgentsService,
            shopify_agent_service_1.ShopifyAgentService,
            shopify_connection_test_service_1.ShopifyConnectionTestService,
            database_connection_test_service_1.DatabaseConnectionTestService,
            twilio_connection_test_service_1.TwilioConnectionTestService,
            openai_connection_test_service_1.OpenAIConnectionTestService,
            elevenlabs_connection_test_service_1.ElevenLabsConnectionTestService,
            order_booking_service_1.OrderBookingService,
            product_sync_queue_1.ShopifyProductSyncQueueService,
        ],
        exports: [
            agents_service_1.AgentsService,
            shopify_agent_service_1.ShopifyAgentService,
            order_booking_service_1.OrderBookingService,
            shopify_connection_test_service_1.ShopifyConnectionTestService,
            twilio_connection_test_service_1.TwilioConnectionTestService,
            openai_connection_test_service_1.OpenAIConnectionTestService,
            elevenlabs_connection_test_service_1.ElevenLabsConnectionTestService,
        ],
    })
], AgentsModule);
//# sourceMappingURL=agents.module.js.map