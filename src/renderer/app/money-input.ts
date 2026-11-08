import { formatUsd } from '../../shared/money';

/**
 * Dollar amounts typed by the player, turned into whole cents as a canonical
 * decimal string for a command payload. Presentation only: the worker
 * validates every amount again. Accepts "2500", "2,500.5", "$2,500.50";
 * refuses negatives, more than two decimals and anything else.
 */
const DOLLARS = /^\$?\s*((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?$/;

export function parseDollarsToCents(text: string): string | null {
  const match = DOLLARS.exec(text.trim());
  if (!match?.[1]) {
    return null;
  }
  const whole = BigInt(match[1].replaceAll(',', ''));
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const cents = whole * 100n + fraction;
  return cents > 0n ? cents.toString() : null;
}

/** "$1,234.56" from a cents decimal string in a read model. */
export function formatCents(cents: string): string {
  return formatUsd(BigInt(cents));
}
