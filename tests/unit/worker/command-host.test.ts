import fc from 'fast-check';
import { worldSnapshotSchema, type CommandEnvelope } from '../../../src/shared/ipc/contract';
import { CommandHost, type CommandHostOptions } from '../../../src/worker/command-host';

const WORLD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_WORLD = '11111111-2222-4333-8444-555555555555';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function makeHost(overrides: Partial<CommandHostOptions> = {}) {
  const faults: string[] = [];
  const wall = { now: 0 };
  const host = new CommandHost({
    worldInstanceId: WORLD,
    seed: 7,
    faultInjectionEnabled: false,
    onThreadFault: (fault) => faults.push(fault),
    pacer: { wallNow: () => wall.now },
    ...overrides,
  });
  return { host, faults, wall };
}

function schedule(n: number, revision: number, delayMs: number, label = `scheduled ${n}`) {
  return {
    commandId: uuid(n),
    worldInstanceId: WORLD,
    expectedWorldRevision: revision,
    type: 'diagnostics.scheduleProbe',
    payload: { label, delayMs },
  };
}

function probe(n: number, revision: number, label = `probe ${n}`): CommandEnvelope {
  return {
    commandId: uuid(n),
    worldInstanceId: WORLD,
    expectedWorldRevision: revision,
    type: 'diagnostics.recordProbe',
    payload: { label },
  };
}

function codeOf(outcome: ReturnType<CommandHost['submit']>): string {
  return outcome.result.ok ? 'OK' : outcome.result.error.code;
}

describe('CommandHost', () => {
  it('starts a paused world at revision 0, time 0, Monday 1 January 1996', () => {
    const snapshot = makeHost().host.snapshot();
    expect(snapshot).toMatchObject({
      worldInstanceId: WORLD,
      worldRevision: 0,
      seed: 7,
      clock: {
        nowMs: '0',
        calendar: { year: 1996, month: 1, day: 1, weekday: 1, hour: 0, minute: 0, second: 0 },
        speed: 'paused',
        advance: null,
        lastStop: null,
        fault: null,
      },
      queue: { pending: 0, nextEventAtMs: null },
      journal: { commands: 0, events: 0 },
      diagnostics: { probeCount: 0, lastProbeLabel: null, pendingProbes: 0, firedProbes: 0 },
    });
    expect(snapshot.fingerprint.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.fingerprint.journalHash).toBe('0'.repeat(64));
    expect(worldSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('accepts a current command, advances the revision by one and returns a receipt', () => {
    const { host } = makeHost();
    const outcome = host.submit(probe(1, 0, 'hello'));
    expect(outcome).toEqual({
      result: {
        ok: true,
        value: {
          commandId: uuid(1),
          worldInstanceId: WORLD,
          worldRevision: 1,
          atMs: '0',
          duplicate: false,
        },
      },
      revised: true,
    });
    expect(host.snapshot().diagnostics).toMatchObject({ probeCount: 1, lastProbeLabel: 'hello' });
    expect(host.snapshot().journal).toEqual({ commands: 1, events: 0 });
  });

  it.each([
    ['not an object', 'MALFORMED_REQUEST'],
    [{ ...probe(1, 0), commandId: 'abc' }, 'MALFORMED_REQUEST'],
    [{ ...probe(1, 0), expectedWorldRevision: 1.5 }, 'MALFORMED_REQUEST'],
    [{ ...probe(1, 0), unexpected: 1 }, 'MALFORMED_REQUEST'],
    [{ ...probe(1, 0), type: 'nope.nothing' }, 'UNKNOWN_COMMAND'],
    [{ ...probe(1, 0), type: 'toString' }, 'UNKNOWN_COMMAND'],
    [{ ...probe(1, 0), payload: { label: '' } }, 'INVALID_PAYLOAD'],
    [{ ...probe(1, 0), payload: { label: 'x'.repeat(81) } }, 'INVALID_PAYLOAD'],
    [{ ...probe(1, 0), payload: null }, 'INVALID_PAYLOAD'],
    [{ ...probe(1, 0), expectedWorldRevision: 3 }, 'STALE_REVISION'],
    [{ ...probe(1, 0), worldInstanceId: OTHER_WORLD }, 'STALE_REVISION'],
    [
      { ...probe(1, 0), type: 'diagnostics.injectFault', payload: { fault: 'thread-exit' } },
      'UNAUTHORIZED',
    ],
  ])('rejects %j with %s and changes nothing', (raw, code) => {
    const { host, faults } = makeHost();
    const before = host.snapshot();
    const outcome = host.submit(raw);
    expect(codeOf(outcome)).toBe(code);
    expect(outcome.revised).toBe(false);
    expect(host.snapshot()).toEqual(before);
    expect(faults).toEqual([]);
  });

  it('reports the current revision when a command is stale', () => {
    const { host } = makeHost();
    host.submit(probe(1, 0));
    const stale = host.submit(probe(2, 0));
    expect(stale.result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'STALE_REVISION',
        details: { currentWorldInstanceId: WORLD, currentWorldRevision: 1 },
      }) as unknown,
    });
  });

  it('answers a resubmitted command from its receipt without re-applying it', () => {
    const { host } = makeHost();
    host.submit(probe(1, 0));
    const again = host.submit(probe(1, 0));
    expect(again.revised).toBe(false);
    expect(again.result).toEqual({
      ok: true,
      value: {
        commandId: uuid(1),
        worldInstanceId: WORLD,
        worldRevision: 1,
        atMs: '0',
        duplicate: true,
      },
    });
    expect(host.snapshot().worldRevision).toBe(1);
    expect(host.snapshot().diagnostics.probeCount).toBe(1);
  });

  it('treats key order as irrelevant when matching a resubmitted command', () => {
    const { host } = makeHost();
    host.submit(probe(1, 0));
    const reordered = {
      payload: { label: 'probe 1' },
      type: 'diagnostics.recordProbe',
      expectedWorldRevision: 0,
      worldInstanceId: WORLD,
      commandId: uuid(1),
    };
    expect(host.submit(reordered).result).toMatchObject({ ok: true, value: { duplicate: true } });
  });

  it('refuses to reuse an accepted command ID for different contents', () => {
    const { host } = makeHost();
    host.submit(probe(1, 0, 'a'));
    expect(codeOf(host.submit(probe(1, 0, 'b')))).toBe('COMMAND_ID_REUSED');
    expect(codeOf(host.submit(probe(1, 1, 'a')))).toBe('COMMAND_ID_REUSED');
    expect(host.snapshot().diagnostics.lastProbeLabel).toBe('a');
  });

  it('allows a rejected command ID to be used again (it was never applied)', () => {
    const { host } = makeHost();
    expect(codeOf(host.submit(probe(1, 5)))).toBe('STALE_REVISION');
    expect(codeOf(host.submit(probe(1, 0)))).toBe('OK');
  });

  describe('with fault injection enabled', () => {
    function fault(name: string, revision = 0): CommandEnvelope {
      return {
        commandId: uuid(99),
        worldInstanceId: WORLD,
        expectedWorldRevision: revision,
        type: 'diagnostics.injectFault',
        payload: { fault: name },
      };
    }

    it('rolls back a handler exception and leaves state untouched', () => {
      const { host, faults } = makeHost({ faultInjectionEnabled: true });
      host.submit(probe(1, 0));
      const before = host.snapshot();
      const outcome = host.submit(fault('handler-exception', 1));
      expect(codeOf(outcome)).toBe('INTERNAL_ERROR');
      // Everything the handler staged — an ID, a random draw, an event and a
      // state change — was discarded: the snapshot, including both
      // fingerprints, is identical.
      expect(host.snapshot()).toEqual(before);
      expect(faults).toEqual([]);
      // The failed command ID was not recorded as accepted.
      expect(codeOf(host.submit(fault('handler-exception', 1)))).toBe('INTERNAL_ERROR');
    });

    it.each(['uncaught-exception', 'thread-exit'])(
      'hands %s to the thread after the command is decided',
      (name) => {
        const { host, faults } = makeHost({ faultInjectionEnabled: true });
        expect(codeOf(host.submit(fault(name)))).toBe('OK');
        expect(faults).toEqual([name]);
      },
    );

    it('rejects unknown fault names', () => {
      const { host } = makeHost({ faultInjectionEnabled: true });
      expect(codeOf(host.submit(fault('meltdown')))).toBe('INVALID_PAYLOAD');
    });
  });

  it('property: the revision equals the number of distinct accepted commands, whatever is submitted', () => {
    const submission = fc.oneof(
      fc.record({
        kind: fc.constant('probe' as const),
        id: fc.integer({ min: 1, max: 8 }),
        revisionOffset: fc.integer({ min: -2, max: 2 }),
        label: fc.string({ minLength: 0, maxLength: 90 }),
        world: fc.constantFrom(WORLD, OTHER_WORLD),
      }),
      fc.record({ kind: fc.constant('junk' as const), value: fc.anything() }),
    );
    fc.assert(
      fc.property(fc.array(submission, { maxLength: 40 }), (submissions) => {
        const { host } = makeHost();
        const acceptedIds = new Set<string>();
        for (const item of submissions) {
          const before = host.snapshot();
          const raw =
            item.kind === 'junk'
              ? item.value
              : {
                  ...probe(
                    item.id,
                    Math.max(0, before.worldRevision + item.revisionOffset),
                    item.label,
                  ),
                  worldInstanceId: item.world,
                };
          const outcome = host.submit(raw);
          if (outcome.revised) {
            expect(outcome.result.ok).toBe(true);
            expect(host.snapshot().worldRevision).toBe(before.worldRevision + 1);
            if (outcome.result.ok) {
              acceptedIds.add(outcome.result.value.commandId);
            }
          } else {
            expect(host.snapshot()).toEqual(before);
          }
        }
        expect(host.snapshot().worldRevision).toBe(acceptedIds.size);
        expect(host.snapshot().diagnostics.probeCount).toBe(acceptedIds.size);
      }),
    );
  });

  describe('scheduled probes and the clock', () => {
    it('schedules a probe event that fires, with a seeded token, when time reaches it', () => {
      const { host } = makeHost();
      expect(codeOf(host.submit(schedule(1, 0, 30 * 60_000, 'half hour')))).toBe('OK');
      expect(host.snapshot()).toMatchObject({
        queue: { pending: 1, nextEventAtMs: String(30 * 60_000) },
        diagnostics: { pendingProbes: 1, firedProbes: 0 },
      });

      host.control({ action: 'advance', until: 'nextEvent' });
      expect(host.tick()).toBe('stopped');
      const after = host.snapshot();
      expect(after.clock).toMatchObject({
        nowMs: String(30 * 60_000),
        calendar: { hour: 0, minute: 30 },
        speed: 'paused',
        advance: null,
        lastStop: { until: 'nextEvent', reason: 'notable', atMs: String(30 * 60_000) },
      });
      expect(after.diagnostics).toMatchObject({
        pendingProbes: 0,
        firedProbes: 1,
        lastFiredProbe: { probeId: 'probe:1', label: 'half hour', firedAtMs: String(30 * 60_000) },
      });
      expect(after.journal).toEqual({ commands: 1, events: 1 });
      // Time and events moved the world, not commands: the revision is unchanged.
      expect(after.worldRevision).toBe(1);

      // The same seed and commands give the same token in another world.
      const { host: twin } = makeHost({ worldInstanceId: OTHER_WORLD });
      twin.submit({ ...schedule(1, 0, 30 * 60_000, 'half hour'), worldInstanceId: OTHER_WORLD });
      twin.control({ action: 'advance', until: 'nextEvent' });
      twin.tick();
      expect(twin.snapshot().diagnostics).toEqual(after.diagnostics);
      expect(twin.snapshot().fingerprint).toEqual(after.fingerprint);
    });

    it('refuses more than 100 pending probes as a business rule', () => {
      const { host } = makeHost();
      for (let n = 1; n <= 100; n += 1) {
        expect(codeOf(host.submit(schedule(n, n - 1, 60_000)))).toBe('OK');
      }
      const before = host.snapshot();
      const refused = host.submit(schedule(101, 100, 60_000));
      expect(refused.result).toMatchObject({
        ok: false,
        error: { code: 'COMMAND_REJECTED', details: { pendingProbes: 100 } },
      });
      expect(host.snapshot()).toEqual(before);
    });

    it('rejects an out-of-range delay before it reaches the rules', () => {
      const { host } = makeHost();
      expect(codeOf(host.submit(schedule(1, 0, 0)))).toBe('INVALID_PAYLOAD');
      expect(codeOf(host.submit(schedule(1, 0, 7 * 86_400_000 + 1)))).toBe('INVALID_PAYLOAD');
      expect(codeOf(host.submit(schedule(1, 0, 1.5)))).toBe('INVALID_PAYLOAD');
    });

    it('runs at the selected speed against the wall clock and does nothing while paused', () => {
      const { host, wall } = makeHost();
      expect(host.tick()).toBe('idle');
      wall.now = 1_000;
      expect(host.tick()).toBe('idle');
      expect(host.snapshot().clock.nowMs).toBe('0');

      host.control({ action: 'setSpeed', speed: 'normal' });
      wall.now += 50;
      expect(host.tick()).toBe('progress');
      expect(host.snapshot().clock.nowMs).toBe(String(50 * 20));
      host.control({ action: 'setSpeed', speed: 'paused' });
      wall.now += 10_000;
      expect(host.tick()).toBe('idle');
      expect(host.snapshot().clock.nowMs).toBe(String(50 * 20));
    });

    it('clock control changes no revision, journal or world hash', () => {
      const { host } = makeHost();
      host.submit(probe(1, 0));
      const before = host.snapshot();
      host.control({ action: 'setSpeed', speed: 'fastest' });
      host.control({ action: 'setSpeed', speed: 'paused' });
      const after = host.snapshot();
      expect(after.worldRevision).toBe(before.worldRevision);
      expect(after.journal).toEqual(before.journal);
      expect(after.fingerprint).toEqual(before.fingerprint);
    });

    it('advances to the end of the day and of the week', () => {
      const { host } = makeHost();
      host.control({ action: 'advance', until: 'endOfDay' });
      expect(host.snapshot().clock.advance).toEqual({ until: 'endOfDay', targetMs: '86400000' });
      expect(host.tick()).toBe('stopped');
      expect(host.snapshot().clock).toMatchObject({
        nowMs: '86400000',
        calendar: { day: 2, weekday: 2, hour: 0 },
        lastStop: { until: 'endOfDay', reason: 'reached' },
      });
      host.control({ action: 'advance', until: 'endOfWeek' });
      host.tick();
      expect(host.snapshot().clock.calendar).toMatchObject({ day: 8, weekday: 1, hour: 0 });
    });
  });
});
