import { MS_PER_DAY, MS_PER_HOUR } from '../../../src/domain/time';
import { SimulationKernel } from '../../../src/simulation/kernel';
import {
  NEXT_EVENT_HORIZON_MS,
  SimulationPacer,
  STEP_MS,
  type PacedKernel,
} from '../../../src/worker/pacer';
import { testUuid, TOY_WORKSHOP } from '../../support/toy-workshop';

const CONFIG = { seed: 77, epoch: { year: 1996, month: 1, day: 1 } };

function setup(options: { sliceBudgetMs?: number; eventsPerCall?: number } = {}) {
  const wall = { now: 1_000 };
  const kernel = SimulationKernel.create(TOY_WORKSHOP, CONFIG);
  const pacer = new SimulationPacer(kernel, { wallNow: () => wall.now, ...options });
  return { wall, kernel, pacer };
}

describe('SimulationPacer', () => {
  it('starts paused and makes zero simulation-time transitions while paused', () => {
    const { wall, kernel, pacer } = setup();
    const before = kernel.fingerprint();
    for (let tick = 0; tick < 100; tick += 1) {
      wall.now += 1_000;
      expect(pacer.tick()).toBe('idle');
    }
    expect(pacer.state).toEqual({ speed: 'paused', advance: null, lastStop: null });
    expect(kernel.fingerprint()).toEqual(before);
  });

  it.each([
    ['normal', 20],
    ['faster', 100],
    ['fastest', 600],
  ] as const)('runs %s at %d simulated ms per wall ms', (speed, rate) => {
    const { wall, kernel, pacer } = setup();
    pacer.setSpeed(speed);
    for (let tick = 0; tick < 20; tick += 1) {
      wall.now += 50;
      pacer.tick();
    }
    expect(kernel.nowMs).toBe(BigInt(20 * 50 * rate));
  });

  it('carries fractions of a simulated millisecond between ticks', () => {
    const { wall, kernel, pacer } = setup();
    pacer.setSpeed('normal');
    for (let tick = 0; tick < 1_024; tick += 1) {
      wall.now += 1 / 64; // exactly representable: 0.3125 simulated ms per tick
      pacer.tick();
    }
    expect(kernel.nowMs).toBe(320n);
  });

  it('converts at most the catch-up limit after a long stall', () => {
    const { wall, kernel, pacer } = setup();
    pacer.setSpeed('normal');
    wall.now += 60_000; // the thread was blocked for a minute
    pacer.tick();
    expect(kernel.nowMs).toBe(BigInt(250 * 20));
  });

  it('lags instead of accumulating debt when the simulation cannot keep up', () => {
    const wall = { now: 0 };
    const kernel = SimulationKernel.create(TOY_WORKSHOP, CONFIG);
    // Each kernel call costs 30 wall ms: more than the 25 ms slice budget.
    const slow: PacedKernel = {
      get nowMs() {
        return kernel.nowMs;
      },
      config: kernel.config,
      get fault() {
        return kernel.fault;
      },
      advanceTo: (target, options) => {
        wall.now += 30;
        return kernel.advanceTo(target, { ...options, maxEvents: 1 });
      },
    };
    const pacer = new SimulationPacer(slow, { wallNow: () => wall.now });
    kernel.submit({
      commandId: testUuid(1),
      expectedWorldRevision: 0,
      type: 'toy.hire',
      payload: { name: 'Ann' },
    });
    pacer.setSpeed('fastest');
    wall.now += 250;
    expect(pacer.tick()).toBe('progress');
    // 250 wall ms × 600 = 150 000 simulated ms requested; one budgeted call made less progress.
    expect(kernel.nowMs > 0n && kernel.nowMs < 150_000n).toBe(true);
  });

  it.each([
    ['step', STEP_MS],
    ['endOfDay', MS_PER_DAY],
    ['endOfWeek', 7n * MS_PER_DAY],
  ] as const)('advances to %s and pauses', (until, target) => {
    const { kernel, pacer } = setup();
    pacer.setSpeed('faster');
    pacer.advance(until);
    expect(pacer.state).toMatchObject({ speed: 'paused', advance: { until, targetMs: target } });
    expect(pacer.tick()).toBe('stopped');
    expect(kernel.nowMs).toBe(target);
    expect(pacer.state).toEqual({
      speed: 'paused',
      advance: null,
      lastStop: { until, reason: 'reached', atMs: target },
    });
    expect(pacer.tick()).toBe('idle');
  });

  it('stops "next event" at the first notable event, or at the horizon', () => {
    const { kernel, pacer } = setup();
    kernel.submit({
      commandId: testUuid(2),
      expectedWorldRevision: 0,
      type: 'toy.setAlarm',
      payload: { delayMs: 5 * 3_600_000 },
    });
    pacer.advance('nextEvent');
    expect(pacer.tick()).toBe('stopped');
    expect(pacer.state.lastStop).toEqual({
      until: 'nextEvent',
      reason: 'notable',
      atMs: 5n * MS_PER_HOUR,
    });
    pacer.advance('nextEvent');
    pacer.tick();
    expect(pacer.state.lastStop).toEqual({
      until: 'nextEvent',
      reason: 'horizon',
      atMs: 5n * MS_PER_HOUR + NEXT_EVENT_HORIZON_MS,
    });
  });

  it('spreads a long advance over several ticks within its wall budget', () => {
    const wall = { now: 0 };
    const kernel = SimulationKernel.create(TOY_WORKSHOP, CONFIG);
    // Busy world: thousands of physical events in a day.
    for (const [n, name] of ['Ann', 'Bo', 'Cy'].entries()) {
      kernel.submit({
        commandId: testUuid(10 + n),
        expectedWorldRevision: kernel.worldRevision,
        type: 'toy.hire',
        payload: { name },
      });
    }
    kernel.submit({
      commandId: testUuid(20),
      expectedWorldRevision: kernel.worldRevision,
      type: 'toy.deliver',
      payload: { quantity: 5_000 },
    });
    // Every wall-clock read costs 1 ms, so a 25 ms slice allows only a few small calls.
    const pacer = new SimulationPacer(kernel, {
      wallNow: () => (wall.now += 1),
      eventsPerCall: 10,
    });
    pacer.advance('endOfDay');
    let ticks = 0;
    while (pacer.tick() !== 'stopped') {
      ticks += 1;
      expect(pacer.state.advance).toEqual({ until: 'endOfDay', targetMs: MS_PER_DAY });
    }
    expect(ticks).toBeGreaterThan(10);
    expect(kernel.nowMs).toBe(MS_PER_DAY);
    expect(pacer.state.lastStop).toEqual({
      until: 'endOfDay',
      reason: 'reached',
      atMs: MS_PER_DAY,
    });
  });

  it('is interrupted by choosing a speed, including Pause', () => {
    const { wall, kernel, pacer } = setup();
    pacer.advance('endOfWeek');
    pacer.setSpeed('paused');
    expect(pacer.state).toEqual({
      speed: 'paused',
      advance: null,
      lastStop: { until: 'endOfWeek', reason: 'interrupted', atMs: 0n },
    });
    wall.now += 10_000;
    expect(pacer.tick()).toBe('idle');
    expect(kernel.nowMs).toBe(0n);
  });

  it('pauses when the kernel faults and refuses to run again', () => {
    const { wall, kernel, pacer } = setup();
    kernel.submit({
      commandId: testUuid(30),
      expectedWorldRevision: 0,
      type: 'toy.scheduleBroken',
      payload: {},
    });
    pacer.setSpeed('fastest');
    wall.now += 200; // 120 simulated seconds: past the broken event at 60 s
    expect(pacer.tick()).toBe('stopped');
    expect(pacer.state.speed).toBe('paused');
    expect(kernel.fault).not.toBeNull();
    pacer.setSpeed('fastest');
    expect(pacer.state.speed).toBe('paused');
    pacer.advance('step');
    expect(pacer.state.lastStop).toMatchObject({ until: 'step', reason: 'fault' });
  });
});
