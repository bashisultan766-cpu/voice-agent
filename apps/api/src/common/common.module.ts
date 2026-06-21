import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EncryptionService } from './encryption.service';
import { LegacyVoicePipelineGuard } from './guards/legacy-voice-pipeline.guard';
import { LegacyVoiceWebSocketBlockerService } from './legacy-voice-websocket-blocker.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [EncryptionService, LegacyVoicePipelineGuard, LegacyVoiceWebSocketBlockerService],
  exports: [EncryptionService, LegacyVoicePipelineGuard],
})
export class CommonModule {}
