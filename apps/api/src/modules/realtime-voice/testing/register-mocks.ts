/** Must be the first import in integration tests that use FullDuplexPipelineService. */
import { installMockElevenLabsTtsPatch } from './mocks/mock-elevenlabs-tts';

installMockElevenLabsTtsPatch();

process.env.ELEVENLABS_STREAMING_TTS_ENABLED = 'true';
process.env.REALTIME_MULTI_AGENT_ENABLED = 'true';
