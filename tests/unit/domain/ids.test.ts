import { formatEntityId, isEntityIdOf, isEntityKind, parseEntityId } from '../../../src/domain/ids';
import {
  MAX_PENDING_PROBES,
  probeFired,
  scheduleProbe,
  INITIAL_DIAGNOSTICS,
} from '../../../src/domain/diagnostics';
import { Rejection } from '../../../src/domain/rejection';

describe('entity IDs', () => {
  it('formats and parses kind:ordinal', () => {
    expect(formatEntityId('probe', 1)).toBe('probe:1');
    expect(formatEntityId('stock-lot', 42)).toBe('stock-lot:42');
    expect(parseEntityId('stock-lot:42')).toEqual({ kind: 'stock-lot', ordinal: 42 });
    expect(isEntityIdOf('probe', 'probe:7')).toBe(true);
    expect(isEntityIdOf('probe', 'worker:7')).toBe(false);
  });

  it.each(['', 'Probe', 'probe_1', '-probe', 'probe-', 'a'.repeat(33), '__proto__'])(
    'rejects the kind %j',
    (kind) => {
      expect(isEntityKind(kind)).toBe(false);
      expect(() => formatEntityId(kind, 1)).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects the ordinal %d', (ordinal) => {
    expect(() => formatEntityId('probe', ordinal)).toThrow(RangeError);
  });

  it.each(['probe', 'probe:', 'probe:0', 'probe:01', ':1', 'probe:1:2', 'probe:99999999999999999'])(
    'does not parse %j',
    (id) => {
      expect(parseEntityId(id)).toBeNull();
    },
  );
});

describe('diagnostics rules', () => {
  it('bounds the number of pending probes', () => {
    let state = INITIAL_DIAGNOSTICS;
    for (let n = 0; n < MAX_PENDING_PROBES; n += 1) {
      const next = scheduleProbe(state);
      if (next instanceof Rejection) {
        throw new Error('rejected too early');
      }
      state = next;
    }
    const refused = scheduleProbe(state);
    expect(refused).toBeInstanceOf(Rejection);
    expect(refused).toMatchObject({ details: { pendingProbes: MAX_PENDING_PROBES } });
  });

  it('refuses to fire a probe that was never scheduled', () => {
    expect(() =>
      probeFired(INITIAL_DIAGNOSTICS, {
        probeId: formatEntityId('probe', 1),
        label: 'x',
        token: 1,
        scheduledAtMs: 0n,
        firedAtMs: 1n,
      }),
    ).toThrow(/no probe was pending/);
  });
});
