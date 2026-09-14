import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalString } from '../src/lib/sentinels.js';

test('optionalString removes source sentinel values', () => {
  for (const value of [null, undefined, '', '  ', 'None', 'NONE']) {
    assert.equal(optionalString(value), undefined);
  }
  assert.equal(optionalString('  ABC  '), 'ABC');
  assert.equal(optionalString(123), '123');
});
