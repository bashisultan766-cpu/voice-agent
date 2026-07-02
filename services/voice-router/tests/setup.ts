process.env.PUBLIC_BASE_URL ??= "https://test.example.com";
process.env.TWILIO_AUTH_TOKEN ??= "test_token";
process.env.VOICE_ROUTER_FORWARD_SECRET ??= "test_router_secret_12345678";
process.env.ORDER_LOOKUP_INBOUND_URL ??= "http://127.0.0.1:8002/voice/order/twilio/inbound";
process.env.MAIN_AGENT_INBOUND_URL ??= "http://127.0.0.1:8001/voice/twilio/inbound";
process.env.ORDER_LOOKUP_HEALTH_URL ??= "http://127.0.0.1:8002/health";
process.env.VALIDATE_TWILIO_SIGNATURES ??= "false";
