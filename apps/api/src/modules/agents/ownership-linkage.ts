import { BadRequestException } from '@nestjs/common';

export function assertProductionOwnershipRequired(params: {
  nodeEnv: string | undefined;
  clientId: string | null | undefined;
  storeId: string | null | undefined;
}) {
  if (params.nodeEnv !== 'production') return;
  if (!params.storeId?.trim()) {
    throw new BadRequestException(
      'storeId is required in production. Add a store under Settings → Integrations (Shopify) or Stores, then select it when creating the agent.',
    );
  }
}

export function assertTenantOwnership(params: {
  tenantId: string;
  clientTenantId?: string | null;
  storeTenantId?: string | null;
}) {
  if (params.clientTenantId && params.clientTenantId !== params.tenantId) {
    throw new BadRequestException('Client does not belong to this tenant.');
  }
  if (params.storeTenantId && params.storeTenantId !== params.tenantId) {
    throw new BadRequestException('Store does not belong to this tenant.');
  }
}
