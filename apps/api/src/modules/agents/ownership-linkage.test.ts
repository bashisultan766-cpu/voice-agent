import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { assertProductionOwnershipRequired, assertTenantOwnership } from './ownership-linkage';

test('requires store in production mode', () => {
  assert.throws(
    () => assertProductionOwnershipRequired({ nodeEnv: 'production', clientId: '', storeId: '' }),
    BadRequestException,
  );
  assert.doesNotThrow(() =>
    assertProductionOwnershipRequired({ nodeEnv: 'production', clientId: '', storeId: 'store_1' }),
  );
});

test('allows missing client/store outside production', () => {
  assert.doesNotThrow(() =>
    assertProductionOwnershipRequired({ nodeEnv: 'development', clientId: '', storeId: '' }),
  );
});

test('rejects cross-tenant ownership linkage', () => {
  assert.throws(
    () => assertTenantOwnership({ tenantId: 'tenant_a', clientTenantId: 'tenant_b' }),
    BadRequestException,
  );
  assert.throws(
    () => assertTenantOwnership({ tenantId: 'tenant_a', storeTenantId: 'tenant_c' }),
    BadRequestException,
  );
});
