import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { getCookieMaxAgeMs } from '../service/tools/config';

test('remember-cookie expiry clamps invalid and excessive values', () => {
  // given
  const original = process.env.COOKIE_TTL_DAYS;
  const day = 86400000;
  try {
    // when / then
    for (const [value, expected] of [
      ['', 30 * day],
      ['invalid', 30 * day],
      ['0', day],
      ['-10', day],
      ['14', 14 * day],
      ['366', 365 * day],
      ['1.5', 30 * day],
    ] as const) {
      process.env.COOKIE_TTL_DAYS = value;
      assert.equal(getCookieMaxAgeMs(), expected, value);
    }
  } finally {
    if (original === undefined) delete process.env.COOKIE_TTL_DAYS;
    else process.env.COOKIE_TTL_DAYS = original;
  }
});
