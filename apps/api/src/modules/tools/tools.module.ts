import { Module, Global } from '@nestjs/common';
import { RuntimeToolRegistryService } from './runtime-tool-registry.service';

@Global()
@Module({
  providers: [RuntimeToolRegistryService],
  exports: [RuntimeToolRegistryService],
})
export class ToolsModule {}
