import { z } from 'zod';
import type { JsonValue } from '../../../src/shared/canonical-json';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../../../src/domain/time';
import { SimulationKernel, type CommandInput } from '../../../src/simulation/kernel';
import {
  defineCommand,
  defineEvent,
  type Lane,
  type SimulationRules,
} from '../../../src/simulation/rules';
import { testUuid, TOY_WORKSHOP, type ToyState } from '../../support/toy-workshop';

const CONFIG = { seed: 2024, epoch: { year: 1996, month: 1, day: 1 } };

function toy() {
  return SimulationKernel.create(TOY_WORKSHOP, CONFIG);
}

let nextId = 1;
function command(kernel: SimulationKernel<unknown>, type: string, payload: unknown): CommandInput {
  return {
    commandId: testUuid(nextId++),
    expectedWorldRevision: kernel.worldRevision,
    type,
    payload,
  };
}

function ok<S>(kernel: SimulationKernel<S>, type: string, payload: unknown) {
  const result = kernel.submit(command(kernel as SimulationKernel<unknown>, type, payload));
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.receipt;
}

/** Minimal rules for precise ordering checks: every event appends its label. */
interface OrderState {
  readonly log: readonly string[];
}

const ORDER_RULES: SimulationRules<OrderState> = {
  id: 'test-order',
  version: 1,
  initialState: () => ({ log: [] }),
  encodeState: (state) => ({ log: [...state.log] }),
  decodeState: (json) => z.strictObject({ log: z.array(z.string()) }).parse(json),
  commands: {
    schedule: defineCommand(
      z.strictObject({
        items: z.array(
          z.strictObject({
            label: z.string(),
            lane: z.enum(['physical', 'economic', 'management', 'accounting', 'diagnostic']),
            delayMs: z.int().min(0),
            notable: z.boolean(),
          }),
        ),
      }),
      (state: OrderState, { items }, context) => {
        for (const item of items) {
          context.schedule({
            type: `${item.lane}${item.notable ? '.notable' : ''}`,
            delayMs: BigInt(item.delayMs),
            payload: { label: item.label },
          });
        }
        return { log: [...state.log, 'command'] };
      },
    ),
    loop: defineCommand(z.strictObject({}), (state: OrderState, _payload, context) => {
      context.schedule({ type: 'loop', delayMs: 1n, payload: {} });
      return state;
    }),
  },
  events: {
    ...Object.fromEntries(
      (['physical', 'economic', 'management', 'accounting', 'diagnostic'] as Lane[]).flatMap(
        (lane) =>
          [false, true].map((notable) => [
            `${lane}${notable ? '.notable' : ''}`,
            defineEvent({
              lane,
              notable,
              payload: z.strictObject({ label: z.string() }),
              handle: (state: OrderState, { label }, context) => ({
                log: [...state.log, `${label}@${context.nowMs}`],
              }),
            }),
          ]),
      ),
    ),
    loop: defineEvent({
      lane: 'physical',
      payload: z.strictObject({}),
      handle: (state: OrderState, _payload, context) => {
        context.schedule({ type: 'loop', delayMs: 0n, payload: {} });
        return state;
      },
    }),
  },
  periodic: {},
};

const item = (label: string, lane: Lane, delayMs: number, notable = false) => ({
  label,
  lane,
  delayMs,
  notable,
});

describe('SimulationKernel: creation and reads', () => {
  it('starts at time 0, revision 0, with time-0 periodic decisions already processed', () => {
    const kernel = toy();
    expect(kernel.nowMs).toBe(0n);
    expect(kernel.worldRevision).toBe(0);
    // Market (economic) and review (management) both have phase 0: processed at creation.
    expect(kernel.processedEvents).toBe(2);
    expect(kernel.state.laneTrace).toEqual(['economic', 'management']);
    expect(kernel.pendingEvents().map((event) => [event.type, event.timeMs])).toEqual([
      ['toy.market', 15n * MS_PER_MINUTE],
      ['toy.review', MS_PER_HOUR],
    ]);
    expect(kernel.checkInvariants()).toEqual([]);
  });

  it('rejects an invalid seed, epoch or rules definition', () => {
    expect(() => SimulationKernel.create(TOY_WORKSHOP, { ...CONFIG, seed: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      SimulationKernel.create(TOY_WORKSHOP, {
        ...CONFIG,
        epoch: { year: 1996, month: 2, day: 30 },
      }),
    ).toThrow(RangeError);
    const market = TOY_WORKSHOP.periodic['toy.market'];
    if (!market) {
      throw new Error('fixture');
    }
    expect(() =>
      SimulationKernel.create(
        { ...TOY_WORKSHOP, periodic: { 'toy.market': { ...market, phaseMs: market.periodMs } } },
        CONFIG,
      ),
    ).toThrow(/phase/);
    expect(() =>
      SimulationKernel.create(
        { ...TOY_WORKSHOP, periodic: { ...TOY_WORKSHOP.periodic, 'toy.alarm': market } },
        CONFIG,
      ),
    ).toThrow(/both an event type and a periodic process/);
  });

  it('reads the calendar at the current simulation time', () => {
    const kernel = toy();
    kernel.advanceTo(36n * MS_PER_HOUR + 30n * MS_PER_MINUTE);
    expect(kernel.calendar()).toMatchObject({ day: 2, weekday: 2, hour: 12, minute: 30 });
  });
});

describe('SimulationKernel: commands', () => {
  it('commits a command at the current time and journals it with its facts', () => {
    const kernel = toy();
    kernel.advanceTo(5_000n);
    const receipt = ok(kernel, 'toy.hire', { name: 'Nora' });
    expect(receipt).toMatchObject({ worldRevision: 1, atMs: 5_000n, duplicate: false });
    expect(kernel.state.workers).toEqual([{ id: 'worker:1', name: 'Nora', moved: 0 }]);
    const entry = kernel.journal.entries.at(-1);
    expect(entry).toMatchObject({
      kind: 'command',
      atMs: 5_000n,
      revision: 1,
      type: 'toy.hire',
      payload: { name: 'Nora' },
      facts: [{ type: 'toy.hired', data: { id: 'worker:1', name: 'Nora' } }],
    });
  });

  it('answers a resubmitted command from the journal and refuses a reused ID', () => {
    const kernel = toy();
    const deliveredBefore = kernel.state.delivered;
    const input = command(kernel as SimulationKernel<unknown>, 'toy.deliver', { quantity: 3 });
    expect(kernel.submit(input)).toMatchObject({ ok: true, receipt: { duplicate: false } });
    kernel.advanceTo(10_000n);
    expect(kernel.submit(input)).toEqual({
      ok: true,
      receipt: { commandId: input.commandId, worldRevision: 1, atMs: 0n, duplicate: true },
    });
    expect(kernel.state.delivered).toBe(deliveredBefore + 3);
    expect(kernel.submit({ ...input, payload: { quantity: 4 } })).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_ID_REUSED' },
    });
  });

  it.each<[string, (kernel: SimulationKernel<ToyState>) => CommandInput, string]>([
    [
      'an unknown type',
      (k) => command(k as SimulationKernel<unknown>, 'toy.teleport', {}),
      'UNKNOWN_COMMAND',
    ],
    [
      'an inherited name',
      (k) => command(k as SimulationKernel<unknown>, 'toString', {}),
      'UNKNOWN_COMMAND',
    ],
    [
      'an invalid payload',
      (k) => command(k as SimulationKernel<unknown>, 'toy.deliver', { quantity: 0 }),
      'INVALID_PAYLOAD',
    ],
    [
      'a stale revision',
      (k) => ({
        ...command(k as SimulationKernel<unknown>, 'toy.deliver', { quantity: 1 }),
        expectedWorldRevision: 5,
      }),
      'STALE_REVISION',
    ],
    [
      'a handler exception',
      (k) => command(k as SimulationKernel<unknown>, 'toy.explode', {}),
      'INTERNAL_ERROR',
    ],
  ])('refuses %s and changes nothing at all', (_name, build, code) => {
    const kernel = toy();
    ok(kernel, 'toy.hire', { name: 'Ann' });
    const before = kernel.checkpoint();
    const fingerprint = kernel.fingerprint();
    const result = kernel.submit(build(kernel));
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(kernel.checkpoint()).toEqual(before);
    expect(kernel.fingerprint()).toEqual(fingerprint);
  });

  it('discards an exploded handler’s staged ID, random draw, event and fact', () => {
    const exploded = toy();
    exploded.submit(command(exploded as SimulationKernel<unknown>, 'toy.explode', {}));
    ok(exploded, 'toy.hire', { name: 'Bo' });
    const clean = toy();
    ok(clean, 'toy.hire', { name: 'Bo' });
    // Same ID (worker:1), same random delay, same queue: nothing leaked.
    expect(exploded.state).toEqual(clean.state);
    expect(exploded.pendingEvents()).toEqual(clean.pendingEvents());
    expect(exploded.fingerprint().stateHash).toBe(clean.fingerprint().stateHash);
  });

  it('returns a business-rule rejection as COMMAND_REJECTED without journaling it', () => {
    const kernel = toy();
    for (let n = 0; n < 8; n += 1) {
      ok(kernel, 'toy.hire', { name: `W${n}` });
    }
    const result = kernel.submit(
      command(kernel as SimulationKernel<unknown>, 'toy.hire', { name: 'Ninth' }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_REJECTED', message: 'The toy workshop has room for eight workers' },
    });
    expect(kernel.journal.commandCount).toBe(8);
  });

  it('runs events a command schedules for "now" straight after it', () => {
    const kernel = SimulationKernel.create(ORDER_RULES, CONFIG);
    kernel.advanceTo(100n);
    ok(kernel, 'schedule', { items: [item('now', 'physical', 0), item('later', 'physical', 5)] });
    expect(kernel.state.log).toEqual(['command', 'now@100']);
    expect(kernel.journal.entries.map((entry) => entry.kind)).toEqual(['command', 'event']);
    expect(kernel.checkInvariants()).toEqual([]);
  });
});

describe('SimulationKernel: time and ordering', () => {
  it('orders one instant by lane, then by scheduling order', () => {
    const kernel = SimulationKernel.create(ORDER_RULES, CONFIG);
    ok(kernel, 'schedule', {
      items: [
        item('accounting', 'accounting', 10),
        item('management', 'management', 10),
        item('economic-1', 'economic', 10),
        item('physical-1', 'physical', 10),
        item('economic-2', 'economic', 10),
        item('physical-2', 'physical', 10),
        item('early', 'diagnostic', 9),
      ],
    });
    kernel.advanceTo(10n);
    expect(kernel.state.log).toEqual([
      'command',
      'early@9',
      'physical-1@10',
      'physical-2@10',
      'economic-1@10',
      'economic-2@10',
      'management@10',
      'accounting@10',
    ]);
  });

  it('refuses to move the clock backwards or schedule into the past', () => {
    const kernel = SimulationKernel.create(ORDER_RULES, CONFIG);
    kernel.advanceTo(50n);
    expect(() => kernel.advanceTo(49n)).toThrow(RangeError);
    const result = kernel.submit({
      commandId: testUuid(900),
      expectedWorldRevision: 0,
      type: 'schedule',
      payload: { items: [item('past', 'physical', -1)] },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('honours an event budget only at instant boundaries', () => {
    const kernel = SimulationKernel.create(ORDER_RULES, CONFIG);
    ok(kernel, 'schedule', {
      items: [item('a', 'physical', 5), item('b', 'economic', 5), item('c', 'physical', 6)],
    });
    expect(kernel.advanceTo(100n, { maxEvents: 1 })).toEqual({
      stop: 'budget',
      nowMs: 5n,
      processed: 2,
    });
    expect(kernel.state.log).toEqual(['command', 'a@5', 'b@5']);
    expect(kernel.checkInvariants()).toEqual([]);
    expect(kernel.advanceTo(100n, { maxEvents: 1 })).toEqual({
      stop: 'reached',
      nowMs: 100n,
      processed: 1,
    });
  });

  it('stops after the instant holding a notable event, even if it is the last one', () => {
    const kernel = SimulationKernel.create(ORDER_RULES, CONFIG);
    ok(kernel, 'schedule', {
      items: [
        item('plain', 'physical', 3),
        item('alarm', 'management', 7, true),
        item('same-instant', 'accounting', 7),
        item('after', 'physical', 9),
      ],
    });
    expect(kernel.advanceTo(1_000n, { stopAfterNotable: true })).toEqual({
      stop: 'notable',
      nowMs: 7n,
      processed: 3,
    });
    expect(kernel.state.log.at(-1)).toBe('same-instant@7');
    // Regression: a notable event that is the last before the target still stops there.
    const last = SimulationKernel.create(ORDER_RULES, CONFIG);
    ok(last, 'schedule', { items: [item('alarm', 'management', 7, true)] });
    expect(last.advanceTo(1_000n, { stopAfterNotable: true })).toMatchObject({
      stop: 'notable',
      nowMs: 7n,
    });
  });

  it('fires periodic decisions on the epoch grid however the clock is advanced', () => {
    const whole = toy();
    whole.advanceTo(2n * MS_PER_HOUR);
    const pieces = toy();
    for (const target of [1n, 899_999n, 900_000n, 900_001n, 5_000_000n, 2n * MS_PER_HOUR]) {
      pieces.advanceTo(target);
    }
    // Market every 15 minutes from 0: 0, 15, …, 120 → 9 rounds; review hourly: 0, 60, 120 → 3.
    expect(whole.state.marketRounds).toBe(9);
    expect(whole.state.reviews).toBe(3);
    expect(pieces.fingerprint()).toEqual(whole.fingerprint());
  });
});

describe('SimulationKernel: faults', () => {
  it('stops on an event handler failure, leaving the world as it was before the event', () => {
    const kernel = toy();
    ok(kernel, 'toy.scheduleBroken', {});
    const before = kernel.checkpoint();
    expect(kernel.advanceTo(MS_PER_HOUR)).toMatchObject({ stop: 'fault', nowMs: 0n });
    expect(kernel.fault).toMatchObject({
      atMs: MS_PER_MINUTE,
      type: 'toy.broken',
      message: expect.stringContaining('toy event failure') as unknown,
    });
    expect(kernel.checkpoint()).toEqual(before);
    expect(kernel.advanceTo(2n * MS_PER_HOUR)).toMatchObject({ stop: 'fault', processed: 0 });
    expect(
      kernel.submit(command(kernel as SimulationKernel<unknown>, 'toy.deliver', { quantity: 1 })),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('stops a runaway event that keeps rescheduling itself at one instant', () => {
    const kernel = SimulationKernel.create(ORDER_RULES, CONFIG);
    ok(kernel, 'loop', {});
    expect(kernel.advanceTo(10n).stop).toBe('fault');
    expect(kernel.fault?.message).toMatch(/runaway/);
  });
});

describe('SimulationKernel: checkpoints', () => {
  function busyWorld() {
    const kernel = toy();
    ok(kernel, 'toy.hire', { name: 'Ann' });
    ok(kernel, 'toy.hire', { name: 'Bo' });
    ok(kernel, 'toy.deliver', { quantity: 40 });
    kernel.advanceTo(3n * MS_PER_HOUR + 1_234n);
    ok(kernel, 'toy.setAlarm', { delayMs: 60_000 });
    kernel.advanceTo(4n * MS_PER_HOUR);
    return kernel;
  }

  it('restores a world that continues exactly like the original', () => {
    const original = busyWorld();
    const restored = SimulationKernel.restore(TOY_WORKSHOP, original.checkpoint());
    expect(restored.fingerprint()).toEqual(original.fingerprint());
    const next = command(original as SimulationKernel<unknown>, 'toy.deliver', { quantity: 5 });
    for (const kernel of [original, restored]) {
      expect(kernel.submit(next)).toMatchObject({ ok: true, receipt: { duplicate: false } });
      kernel.advanceTo(30n * MS_PER_HOUR);
    }
    expect(restored.fingerprint()).toEqual(original.fingerprint());
    expect(restored.checkInvariants()).toEqual([]);
  });

  it('survives a JSON round trip (the checkpoint is plain data)', () => {
    const original = busyWorld();
    const json = JSON.parse(JSON.stringify(original.checkpoint())) as JsonValue;
    expect(SimulationKernel.restore(TOY_WORKSHOP, json).fingerprint()).toEqual(
      original.fingerprint(),
    );
  });

  interface Checkpoint {
    state: Record<string, unknown>;
    journal: Record<string, unknown>[];
  }
  const tamper = (edit: (checkpoint: Checkpoint) => void) => {
    const checkpoint = JSON.parse(JSON.stringify(busyWorld().checkpoint())) as Checkpoint;
    edit(checkpoint);
    return () => SimulationKernel.restore(TOY_WORKSHOP, checkpoint);
  };

  it.each<[string, (checkpoint: Checkpoint) => void, RegExp]>([
    ['another rule set', (c) => (c.state['rules'] = { id: 'other', version: 1 }), /rules other/],
    ['a newer kernel format', (c) => (c.state['format'] = 2), /format 2/],
    ['another RNG', (c) => (c.state['rng'] = 'mt19937'), /RNG/],
    [
      'a revision that disagrees with the journal',
      (c) => (c.state['worldRevision'] = 9),
      /revision 9/,
    ],
    ['a missing journal entry', (c) => c.journal.splice(1, 1), /sequence/],
    [
      'an edited command payload',
      (c) => {
        const command = c.journal.find((entry) => entry['type'] === 'toy.deliver');
        if (command) {
          command['payload'] = { quantity: 41 };
        }
      },
      /inconsistent fingerprint/,
    ],
    [
      'a re-prioritised event',
      (c) => {
        const [first] = c.state['queue'] as Record<string, unknown>[];
        if (first) {
          first['priority'] = 1;
        }
      },
      /priority 1/,
    ],
    ['a negative clock', (c) => (c.state['nowMs'] = '-1'), /Invalid world checkpoint/],
    [
      'an unknown event type',
      (c) => {
        const [first] = c.state['queue'] as Record<string, unknown>[];
        if (first) {
          first['type'] = 'toy.unknown';
        }
      },
      /unknown type/,
    ],
    [
      'an all-zero RNG stream',
      (c) => {
        (c.state['rngStreams'] as Record<string, number[]>)['labour'] = [0, 0, 0, 0];
      },
      /RNG stream/,
    ],
    [
      'unconserved stock',
      (c) => {
        const domain = c.state['domain'] as Record<string, number>;
        domain['shelf'] = (domain['shelf'] ?? 0) + 1;
      },
      /stock not conserved/,
    ],
  ])('refuses a checkpoint with %s', (_name, edit, message) => {
    expect(tamper(edit)).toThrow(message);
  });
});

describe('module boundaries', () => {
  it('runs the kernel without loading Electron or PixiJS', () => {
    const loaded = Object.keys(require.cache);
    expect(loaded.some((path) => /node_modules[\\/](electron|pixi\.js)[\\/]/.test(path))).toBe(
      false,
    );
  });
});
