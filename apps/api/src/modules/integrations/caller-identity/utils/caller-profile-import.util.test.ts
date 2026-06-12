import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseThreeCxContactsCsv, parseThreeCxContactsJson } from './caller-profile-import.util';

describe('parseThreeCxContactsCsv', () => {
  test('parses standard 3CX-style CSV headers', () => {
    const csv = `FirstName,LastName,Mobile,Email,Company
Justin,Smith,+12515551234,justin@example.com,SureShot`;

    const rows = parseThreeCxContactsCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phone, '+12515551234');
    assert.equal(rows[0].firstName, 'Justin');
    assert.equal(rows[0].lastName, 'Smith');
    assert.equal(rows[0].displayName, 'Justin Smith');
    assert.equal(rows[0].email, 'justin@example.com');
    assert.equal(rows[0].company, 'SureShot');
  });

  test('imports multiple phone columns from one contact row', () => {
    const csv = `Name,Phone,Mobile
Acme Buyer,2515551000,2515552000`;

    const rows = parseThreeCxContactsCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.displayName === 'Acme Buyer'), true);
  });
});

describe('parseThreeCxContactsJson', () => {
  test('parses contacts array', () => {
    const rows = parseThreeCxContactsJson({
      contacts: [{ FirstName: 'Jane', LastName: 'Doe', Mobile: '2515559999' }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].displayName, 'Jane Doe');
    assert.equal(rows[0].phone, '+12515559999');
  });
});
