import { z } from 'zod';

/**
 * Money (spec §8.1, DECISIONS ADR-0030). Every amount is an integer number of
 * US cents held as a `bigint`; it crosses JSON (IPC, journal payloads) as a
 * canonical decimal string. There is no floating-point money anywhere.
 *
 * Limits keep every stored value far inside SQLite's signed 64-bit INTEGER
 * (about 9.2 × 10^18): a single document or ledger line is at most
 * $100 billion, and no account balance may exceed $10 trillion in either
 * direction. A posting that would cross a limit is refused, never wrapped.
 */

export type Cents = bigint;

/** Largest amount on one invoice, payment or ledger line: $100,000,000,000.00. */
export const MAX_AMOUNT_CENTS: Cents = 10n ** 13n;

/** Largest magnitude of any account balance: $10,000,000,000,000.00. */
export const MAX_BALANCE_CENTS: Cents = 10n ** 15n;

/** A positive amount within {@link MAX_AMOUNT_CENTS}. */
export function isPositiveAmount(cents: Cents): boolean {
  return cents > 0n && cents <= MAX_AMOUNT_CENTS;
}

const POSITIVE_CENTS = /^[1-9][0-9]{0,13}$/;

/**
 * A positive cents amount as a canonical decimal string (1 to 10^13). Zod
 * runs a refinement even when the regex has already failed, so the bound
 * check must not assume the text is a number (regression: "12.50" made
 * `BigInt` throw inside validation).
 */
export const positiveCentsString = z
  .string()
  .regex(POSITIVE_CENTS, 'Expected a positive whole number of cents')
  .refine(
    (text) => !POSITIVE_CENTS.test(text) || BigInt(text) <= MAX_AMOUNT_CENTS,
    'Amount is above the largest allowed',
  );

/** A signed cents amount as a canonical decimal string (balances, totals). */
export const signedCentsString = z.string().regex(/^(?:0|-?[1-9][0-9]{0,18})$/);

/** A non-negative cents amount as a canonical decimal string. */
export const nonNegativeCentsString = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);

/**
 * "$1,234.56", "-$0.05". Exact: works on the integer cents, so no amount is
 * ever rounded for display.
 */
export function formatUsd(cents: Cents): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const dollars = (magnitude / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${fraction}`;
}
