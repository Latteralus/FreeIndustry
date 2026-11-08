import { formatCents, parseDollarsToCents } from '../../../src/renderer/app/money-input';

describe('dollar input', () => {
  it.each([
    ['2500', '250000'],
    ['2,500', '250000'],
    ['$2,500.5', '250050'],
    ['$ 1,234,567.89', '123456789'],
    ['0.01', '1'],
    ['  75  ', '7500'],
  ])('%j is %s cents', (text, cents) => {
    expect(parseDollarsToCents(text)).toBe(cents);
  });

  it.each(['', '0', '0.00', '-5', '1.234', '12,34', '1e5', 'abc', '1,000,00', '$'])(
    'refuses %j',
    (text) => {
      expect(parseDollarsToCents(text)).toBeNull();
    },
  );

  it('formats read-model cents exactly', () => {
    expect(formatCents('123456789')).toBe('$1,234,567.89');
    expect(formatCents('-1200000')).toBe('-$12,000.00');
  });
});
