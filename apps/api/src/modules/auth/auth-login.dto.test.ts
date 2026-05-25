import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto, resolveLoginWorkspaceSlug } from './dto/login.dto';

/**
 * Auth rule: login requires workspace slug + email + password for the same tenant user.
 * Wrong slug must not succeed even when email/password match another workspace.
 */
test('LoginDto normalizes workspaceSlug', async () => {
  const dto = plainToInstance(LoginDto, {
    workspaceSlug: '  ACME-Corp ',
    email: 'user@example.com',
    password: 'secret',
  });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
  assert.equal(resolveLoginWorkspaceSlug(dto), 'acme-corp');
});

test('LoginDto accepts legacy tenantSlug alias', async () => {
  const dto = plainToInstance(LoginDto, {
    tenantSlug: 'legacy-ws',
    email: 'user@example.com',
    password: 'secret',
  });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
  assert.equal(resolveLoginWorkspaceSlug(dto), 'legacy-ws');
});

test('LoginDto rejects missing workspace slug', async () => {
  const dto = plainToInstance(LoginDto, {
    email: 'user@example.com',
    password: 'secret',
  });
  const errors = await validate(dto);
  assert.ok(errors.length > 0);
});
