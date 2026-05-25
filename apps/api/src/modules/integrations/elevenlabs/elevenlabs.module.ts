import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ElevenLabsService } from './elevenlabs.service';
import { ElevenLabsStreamingService } from './elevenlabs-streaming.service';
import { ElevenLabsController } from './elevenlabs.controller';

@Module({
  imports: [ConfigModule],
  controllers: [ElevenLabsController],
  providers: [ElevenLabsService, ElevenLabsStreamingService],
  exports: [ElevenLabsService, ElevenLabsStreamingService],
})
export class ElevenLabsModule {}
