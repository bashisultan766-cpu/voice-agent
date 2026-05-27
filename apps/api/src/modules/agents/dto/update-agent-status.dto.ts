import { IsEnum } from 'class-validator';
import { AgentStatusDto } from './create-agent.dto';

/** Status-only updates from the agents list (activate uses readiness / go-live). */
export class UpdateAgentStatusDto {
  @IsEnum(AgentStatusDto)
  status!: AgentStatusDto;
}
