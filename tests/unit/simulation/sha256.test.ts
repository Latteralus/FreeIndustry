import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { sha256Hex } from '../../../src/simulation/sha256';

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('matches the FIPS 180-4 test vector for %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('matches Node crypto around block-padding boundaries', () => {
    for (let length = 0; length <= 130; length += 1) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('property: matches Node crypto for arbitrary Unicode text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 300 }), (text) => {
        expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      }),
    );
  });

  it('handles a large input', () => {
    const text = 'FreeIndustry'.repeat(50_000);
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });
});
