import type { RequestOutcome } from './useSimulationHost';

/** The outcome of the last request, in words. */
export function describeOutcome(outcome: RequestOutcome | null): string {
  if (!outcome) {
    return '—';
  }
  if (outcome.kind === 'accepted') {
    return outcome.duplicate
      ? `Already accepted (revision ${outcome.worldRevision})`
      : `Accepted at revision ${outcome.worldRevision}`;
  }
  return `Rejected (${outcome.error.code}): ${outcome.error.message}`;
}
