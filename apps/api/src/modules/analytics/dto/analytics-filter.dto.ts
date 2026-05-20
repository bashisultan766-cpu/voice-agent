import { IsOptional, IsDateString } from 'class-validator';

export class AnalyticsFilterDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
