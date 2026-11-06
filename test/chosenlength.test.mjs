import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLength } from '../src/svc/chosenlength.mjs';

test('chosen length: seconds, minutes, both; ranges and words are null', () => {
  assert.equal(parseLength('60 s'), 60);
  assert.equal(parseLength('90s'), 90);
  assert.equal(parseLength('1 min'), 60);
  assert.equal(parseLength('1 min 30 s'), 90);
  assert.equal(parseLength('45'), 45);
  assert.equal(parseLength('30 to 120 s'), null);
  assert.equal(parseLength('30–120 s'), null);
  assert.equal(parseLength('short'), null);
  assert.equal(parseLength(''), null);
  assert.equal(parseLength(undefined), null);
});
