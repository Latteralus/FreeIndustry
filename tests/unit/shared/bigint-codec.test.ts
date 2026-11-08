import fc from 'fast-check';
import { bigIntString, decodeBigInt, encodeBigInt } from '../../../src/shared/bigint-codec';

describe('bigint decimal-string codec', () => {
  it('round-trips every bigint exactly', () => {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        expect(decodeBigInt(encodeBigInt(value))).toBe(value);
      }),
    );
  });

  it('produces exactly one encoding per value', () => {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        expect(encodeBigInt(decodeBigInt(encodeBigInt(value)))).toBe(encodeBigInt(value));
      }),
    );
  });

  it.each(['', '-0', '+1', '01', ' 1', '1 ', '1.0', '1e3', '0x10', '--1', '١'])(
    'rejects non-canonical text %j',
    (text) => {
      expect(() => decodeBigInt(text)).toThrow(RangeError);
      expect(bigIntString.safeParse(text).success).toBe(false);
    },
  );

  it('decodes values beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const big = '9223372036854775807123';
    expect(bigIntString.parse(big)).toBe(9223372036854775807123n);
  });
});
