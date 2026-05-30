import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  query!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  limit?: number;
}

export type SearchProductResponseDto = {
  success: boolean;
  products: Array<{
    productId: string;
    variantId: string;
    title: string;
    price: string | null;
    inventory: number;
    image: string | null;
    sku: string | null;
    inStock: boolean;
  }>;
  cacheHit?: boolean;
  latencyMs?: number;
  error?: string;
};
