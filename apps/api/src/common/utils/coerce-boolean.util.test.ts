import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coerceBoolean, pickBooleanFromRecord } from './coerce-boolean.util';

test('coerceBoolean handles primitives and string forms', () => {
  assert.equal(coerceBoolean(true), true);
  assert.equal(coerceBoolean(false), false);
  assert.equal(coerceBoolean(1), true);
  assert.equal(coerceBoolean(0), false);
  assert.equal(coerceBoolean('yes'), true);
  assert.equal(coerceBoolean('no'), false);
  assert.equal(coerceBoolean('TRUE'), true);
  assert.equal(coerceBoolean(undefined), undefined);
});

test('pickBooleanFromRecord reads first matching key', () => {
  assert.equal(
    pickBooleanFromRecord({ emailComfirmed: '1', emailConfirmed: false }, [
      'emailConfirmed',
      'emailComfirmed',
    ]),
    false,
  );
  assert.equal(
    pickBooleanFromRecord({ email_comfirmed: 'yes' }, ['emailConfirmed', 'email_comfirmed']),
    true,
  );
});
