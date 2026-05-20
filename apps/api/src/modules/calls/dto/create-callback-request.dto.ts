import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateCallbackRequestDto {
  @IsString()
  @Length(5, 64)
  phone!: string;

  @IsString()
  @Length(3, 500)
  reason!: string;

  @IsOptional()
  @IsString()
  @IsIn(['low', 'normal', 'high'])
  priority?: 'low' | 'normal' | 'high';

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}
