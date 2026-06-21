import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';

@Public()
@Controller()
export class RootController {
  @Get()
  root() {
    return {
      service: 'Voice Agent API',
      message:
        'This is the API. The admin UI is the Next.js app (usually http://127.0.0.1:3000). Routes live under /api.',
      adminUi: 'http://127.0.0.1:3000',
      endpoints: {
        health: '/api/health',
        twilioConfigCheck: '/api/twilio/config-check',
        twilioInboundVoiceDeprecated: '/api/twilio/voice/inbound (410 Gone — use services/voice-agent POST /voice/incoming)',
        activeVoicePipeline: 'services/voice-agent: POST /voice/incoming → wss /ws/stream',
      },
    };
  }
}
