import { Global, Module } from '@nestjs/common';
import { VoiceCallDiagnosticsService } from './services/voice-call-diagnostics.service';

/** Lightweight diagnostics store — safe to import from ElevenLabs without circular deps. */
@Global()
@Module({
  providers: [VoiceCallDiagnosticsService],
  exports: [VoiceCallDiagnosticsService],
})
export class VoiceDiagnosticsModule {}
