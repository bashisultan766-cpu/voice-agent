import { Module } from '@nestjs/common';
import { ToolsModule } from '../../tools/tools.module';
import { OpenAIPromptBuilderService } from './openai-prompt-builder.service';
import { OpenAIToolRegistryService } from './openai-tool-registry.service';

@Module({
  imports: [ToolsModule],
  providers: [OpenAIPromptBuilderService, OpenAIToolRegistryService],
  exports: [OpenAIPromptBuilderService, OpenAIToolRegistryService],
})
export class OpenAIModule {}
