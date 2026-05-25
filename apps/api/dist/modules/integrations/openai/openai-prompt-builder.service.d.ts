import { VoiceSessionContext } from '../../calls/runtime/session-context.service';
import { RuntimeToolRegistryService } from '../../tools/runtime-tool-registry.service';
export declare class OpenAIPromptBuilderService {
    private readonly toolRegistry;
    constructor(toolRegistry: RuntimeToolRegistryService);
    build(ctx: VoiceSessionContext): string;
}
