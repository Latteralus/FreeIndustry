import { MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND } from '../../src/domain/time';
import { SimulationKernel, type CommandInput } from '../../src/simulation/kernel';
import {
  replayJournal,
  runScenario,
  type ScriptedCommand,
} from '../../src/simulation/scenario-runner';
import type { SimulationSpeed } from '../../src/shared/ipc/clock';
import { SimulationPacer } from '../../src/worker/pacer';
import { testUuid, TOY_WORKSHOP } from '../support/toy-workshop';

/**
 * Scenario S10 (spec §14.2) / ledger T-TIME-01: a busy simulated week run
 * headless at full speed, paced like the real app at 1×/20×/100×/600× and
 * different frame rates, and driven through the real pacer by a "player"
 * who pauses at controlled events. The domain outcome must be identical.
 * (The world is a test fixture; FreeIndustry's own rules arrive in Step 05+.)
 */

const CONFIG = { seed: 1996, epoch: { year: 1996, month: 1, day: 1 } };
const WEEK = 7n * MS_PER_DAY;

const SCRIPT: ScriptedCommand[] = [
  { atMs: 0n, commandId: testUuid(1), type: 'toy.hire', payload: { name: 'Nora' } },
  { atMs: 0n, commandId: testUuid(2), type: 'toy.hire', payload: { name: 'Otto' } },
  { atMs: 0n, commandId: testUuid(3), type: 'toy.deliver', payload: { quantity: 400 } },
  { atMs: 9n * MS_PER_HOUR, commandId: testUuid(4), type: 'toy.hire', payload: { name: 'Pat' } },
  {
    atMs: MS_PER_DAY + 30n * MS_PER_SECOND,
    commandId: testUuid(5),
    type: 'toy.setAlarm',
    payload: { delayMs: 10 * 3_600_000 },
  },
  {
    atMs: 3n * MS_PER_DAY,
    commandId: testUuid(6),
    type: 'toy.deliver',
    payload: { quantity: 2_500 },
  },
  {
    atMs: 4n * MS_PER_DAY + 7n,
    commandId: testUuid(7),
    type: 'toy.hire',
    payload: { name: 'Quin' },
  },
];

const reference = runScenario({
  rules: TOY_WORKSHOP,
  config: CONFIG,
  commands: SCRIPT,
  untilMs: WEEK,
});

/** Clock advance per pacing tick: wall tick (ms) × speed rate. */
const chunk = (tickMs: number, rate: number) => BigInt(tickMs * rate);

describe('S10 / T-TIME-01: fast-forward equals slow, visible running', () => {
  it('is a busy world, so the comparison means something', () => {
    const state = reference.kernel.state;
    expect(reference.kernel.processedEvents).toBeGreaterThan(30_000);
    expect(state.shipped).toBeGreaterThan(0);
    expect(state.marketRounds).toBe(7 * 96 + 1);
    expect(state.reviews).toBe(7 * 24 + 1);
    expect(state.alarms).toBe(1);
    expect(reference.rejected).toEqual([]);
    expect(reference.kernel.checkInvariants()).toEqual([]);
  });

  it.each([
    ['20× at 20 fps', chunk(50, 20)],
    ['100× at 60 fps', chunk(16, 100)],
    ['600× at 20 fps', chunk(50, 600)],
    ['600× at 144 fps', chunk(7, 600)],
  ])('matches the headless run when paced at %s for the whole week', (_name, step) => {
    const paced = runScenario({
      rules: TOY_WORKSHOP,
      config: CONFIG,
      commands: SCRIPT,
      untilMs: WEEK,
      pacing: { chunksMs: [step] },
    });
    expect(paced.advanceCalls).toBeGreaterThan(1_000);
    expect(paced.fingerprint).toEqual(reference.fingerprint);
  });

  it('matches at 1× (real time, 50 ms ticks) over the first simulated day', () => {
    const untilMs = MS_PER_DAY;
    const commands = SCRIPT.filter((command) => command.atMs <= untilMs);
    const headless = runScenario({ rules: TOY_WORKSHOP, config: CONFIG, commands, untilMs });
    const realTime = runScenario({
      rules: TOY_WORKSHOP,
      config: CONFIG,
      commands,
      untilMs,
      pacing: { chunksMs: [chunk(50, 1)] },
    });
    expect(realTime.advanceCalls).toBeGreaterThan(1_700_000);
    expect(realTime.fingerprint).toEqual(headless.fingerprint);
  });

  it('matches with jittery frame times and an overloaded machine (tiny event budgets)', () => {
    const jitter = [3n, 900n, 17n, 64_000n, 1n, 250n, 33n, 4_000_000n];
    const overloaded = runScenario({
      rules: TOY_WORKSHOP,
      config: CONFIG,
      commands: SCRIPT,
      untilMs: WEEK,
      pacing: { chunksMs: jitter, maxEventsPerCall: 3 },
    });
    expect(overloaded.fingerprint).toEqual(reference.fingerprint);
  });
});

/**
 * A "player" drives the real pacer with a fake wall clock. Both sessions
 * issue the same commands at the same controlled stop points (a notable
 * event, the end of a day) but play at different speeds and tick rates and
 * pause for different wall-clock lengths in between.
 */
function playSession(style: {
  readonly tickMs: number;
  readonly runningSpeed: Exclude<SimulationSpeed, 'paused'>;
  readonly pauseWallMs: number;
}) {
  const wall = { now: 0 };
  const kernel = SimulationKernel.create(TOY_WORKSHOP, CONFIG);
  const pacer = new SimulationPacer(kernel, { wallNow: () => wall.now });
  let next = 100;
  const submit = (type: string, payload: unknown) => {
    const input: CommandInput = {
      commandId: testUuid(next++),
      expectedWorldRevision: kernel.worldRevision,
      type,
      payload,
    };
    const result = kernel.submit(input);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  };
  const tickUntilStopped = () => {
    for (let guard = 0; guard < 1_000_000; guard += 1) {
      wall.now += style.tickMs;
      if (pacer.tick() === 'stopped') {
        return;
      }
    }
    throw new Error('advance did not finish');
  };
  const runFor = (wallMs: number) => {
    pacer.setSpeed(style.runningSpeed);
    for (let elapsed = 0; elapsed < wallMs; elapsed += style.tickMs) {
      wall.now += style.tickMs;
      pacer.tick();
    }
    pacer.setSpeed('paused');
    wall.now += style.pauseWallMs; // the player thinks; nothing may happen
    pacer.tick();
  };

  // Plan at time 0, while paused.
  submit('toy.hire', { name: 'Nora' });
  submit('toy.deliver', { quantity: 300 });
  submit('toy.setAlarm', { delayMs: 5 * 3_600_000 + 1_234 });
  // Watch for a while, then let the clock run until the alarm (a controlled event).
  runFor(200);
  pacer.advance('nextEvent');
  tickUntilStopped();
  const alarmStop = pacer.state.lastStop;
  // React to the alarm at exactly that simulated instant.
  submit('toy.hire', { name: 'Otto' });
  submit('toy.deliver', { quantity: 900 });
  // Run on, then finish the day and plan again at midnight.
  runFor(150);
  pacer.advance('endOfDay');
  tickUntilStopped();
  submit('toy.setAlarm', { delayMs: 20 * 3_600_000 });
  // Single-step a few minutes, then fast-forward to the end of the week.
  for (let step = 0; step < 5; step += 1) {
    pacer.advance('step');
    tickUntilStopped();
  }
  pacer.advance('endOfWeek');
  tickUntilStopped();
  return { kernel, alarmStop };
}

describe('S10 / T-TIME-01/02: the real pacer under different play styles', () => {
  const careful = playSession({ tickMs: 50, runningSpeed: 'normal', pauseWallMs: 60_000 });
  const hasty = playSession({ tickMs: 7, runningSpeed: 'fastest', pauseWallMs: 5 });

  it('stops at the controlled event at the same simulated instant', () => {
    expect(careful.alarmStop).toEqual({
      until: 'nextEvent',
      reason: 'notable',
      atMs: 5n * MS_PER_HOUR + 1_234n,
    });
    expect(hasty.alarmStop).toEqual(careful.alarmStop);
  });

  it('reaches the end of the week with identical domain state and history', () => {
    expect(careful.kernel.nowMs).toBe(WEEK);
    expect(hasty.kernel.nowMs).toBe(WEEK);
    expect(hasty.kernel.state).toEqual(careful.kernel.state);
    expect(hasty.kernel.fingerprint()).toEqual(careful.kernel.fingerprint());
    expect(careful.kernel.state.alarms).toBe(2);
  });

  it('is reproduced exactly by a headless replay of its journal', () => {
    const replayed = replayJournal(TOY_WORKSHOP, CONFIG, careful.kernel.journal.entries, WEEK);
    expect(replayed.fingerprint()).toEqual(careful.kernel.fingerprint());
  });
});
