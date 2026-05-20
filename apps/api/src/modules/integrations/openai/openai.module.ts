import { Module } from '@nestjs/common';
import { OpenAIPromptBuilderService } from './openai-prompt-builder.service';
import { OpenAIToolRegistryService } from './openai-tool-registry.service';

@Module({
  providers: [OpenAIPromptBuilderService, OpenAIToolRegistryService],
  exports: [OpenAIPromptBuilderService, OpenAIToolRegistryService],
})
export class OpenAIModule {}
