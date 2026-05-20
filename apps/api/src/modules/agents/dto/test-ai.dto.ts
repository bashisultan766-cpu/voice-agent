import { IsString, IsOptional, MaxLength } from 'class-validator';

export class TestAiBehaviorDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  sampleQuery?: string;
}
