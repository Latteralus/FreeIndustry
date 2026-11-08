import fc from 'fast-check';
import type { JsonValue } from '../../src/shared/canonical-json';
import { MS_PER_HOUR, MS_PER_MINUTE } from '../../src/domain/time';
import { SimulationKernel } from '../../src/simulation/kernel';
import {
  replayJournal,
  runScenario,
  type Pacing,
  type ScriptedCommand,
} from '../../src/simulation/scenario-runner';
import { testUuid, TOY_WORKSHOP } from '../support/toy-workshop';

/**
 * Step 03 acceptance gate, as properties: identical seed + starting state +
 * ordered commands give identical fingerprints, whatever the pacing (chunk
 * sizes stand in for frame rates and speeds, zero-progress calls for
 * pauses, event budgets for an overloaded machine), through replay of the
 * journal, and across a checkpoint/restore at any moment.
 */

const HORIZON = 2n * MS_PER_HOUR;
const CONFIG = { seed: 31_337, epoch: { year: 1996, month: 1, day: 1 } };

const commandBody = fc.oneof(
  fc.record({
    type: fc.constant('toy.hire'),
    payload: fc.record({ name: fc.constantFrom('Ann', 'Bo', 'Cy', 'Di') }),
  }),
  fc.record({
    type: fc.constant('toy.deliver'),
    payload: fc.record({ quantity: fc.integer({ min: 1, max: 60 }) }),
  }),
  fc.record({
    type: fc.constant('toy.setAlarm'),
    payload: fc.record({ delayMs: fc.integer({ min: 0, max: 3 * 3_600_000 }) }),
  }),
);

const script = fc
  .array(fc.record({ atMs: fc.bigInt({ min: 0n, max: HORIZON }), body: commandBody }), {
    maxLength: 20,
  })
  .map((items): ScriptedCommand[] =>
    [...items]
      .sort((a, b) => (a.atMs < b.atMs ? -1 : a.atMs > b.atMs ? 1 : 0))
      .map((item, index) => ({
        atMs: item.atMs,
        commandId: testUuid(index + 1),
        type: item.body.type,
        payload: item.body.payload,
      })),
  );

const pacing: fc.Arbitrary<Pacing> = fc.record(
  {
    chunksMs: fc.array(fc.bigInt({ min: 1n, max: 30n * MS_PER_MINUTE }), {
      minLength: 1,
      maxLength: 6,
    }),
    maxEventsPerCall: fc.integer({ min: 1, max: 40 }),
  },
  { requiredKeys: ['chunksMs'] },
);

const seed = fc.integer({ min: 0, max: 0xffff_ffff });

const run = (commands: ScriptedCommand[], worldSeed: number, how?: Pacing) =>
  runScenario({
    rules: TOY_WORKSHOP,
    config: { ...CONFIG, seed: worldSeed },
    commands,
    untilMs: HORIZON,
    ...(how ? { pacing: how } : {}),
  });

describe('determinism properties (Step 03 gate)', () => {
  it('property: pacing, pauses and event budgets never change the outcome', () => {
    fc.assert(
      fc.property(script, seed, pacing, (commands, worldSeed, how) => {
        const reference = run(commands, worldSeed);
        const paced = run(commands, worldSeed, how);
        expect(paced.fingerprint).toEqual(reference.fingerprint);
        expect(paced.kernel.journal.length).toBe(reference.kernel.journal.length);
        expect(paced.kernel.checkInvariants()).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('property: replaying the command journal reproduces both fingerprints', () => {
    fc.assert(
      fc.property(script, seed, pacing, (commands, worldSeed, how) => {
        const live = run(commands, worldSeed, how);
        const replayed = replayJournal(
          TOY_WORKSHOP,
          { ...CONFIG, seed: worldSeed },
          live.kernel.journal.entries,
          HORIZON,
        );
        expect(replayed.fingerprint()).toEqual(live.fingerprint);
      }),
      { numRuns: 100 },
    );
  });

  it('property: a checkpoint taken at any moment continues exactly like the original', () => {
    fc.assert(
      fc.property(
        script,
        seed,
        fc.bigInt({ min: 0n, max: HORIZON }),
        (commands, worldSeed, cutMs) => {
          const reference = run(commands, worldSeed);
          // Run up to the cut, checkpoint through JSON text, restore, finish.
          const kernel = SimulationKernel.create(TOY_WORKSHOP, { ...CONFIG, seed: worldSeed });
          let restored = kernel;
          let cut = false;
          for (const command of commands) {
            if (!cut && command.atMs >= cutMs) {
              restored.advanceTo(cutMs);
              const text = JSON.stringify(restored.checkpoint());
              restored = SimulationKernel.restore(TOY_WORKSHOP, JSON.parse(text) as JsonValue);
              cut = true;
            }
            restored.advanceTo(command.atMs);
            restored.submit({
              commandId: command.commandId,
              expectedWorldRevision: restored.worldRevision,
              type: command.type,
              payload: command.payload,
            });
          }
          if (!cut) {
            restored.advanceTo(cutMs);
            restored = SimulationKernel.restore(
              TOY_WORKSHOP,
              JSON.parse(JSON.stringify(restored.checkpoint())) as JsonValue,
            );
          }
          restored.advanceTo(HORIZON);
          expect(restored.fingerprint()).toEqual(reference.fingerprint);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: every command outcome is all-or-nothing (invariants hold after each step)', () => {
    fc.assert(
      fc.property(script, seed, (commands, worldSeed) => {
        const kernel = SimulationKernel.create(TOY_WORKSHOP, { ...CONFIG, seed: worldSeed });
        for (const command of commands) {
          kernel.advanceTo(command.atMs);
          kernel.submit({
            commandId: command.commandId,
            expectedWorldRevision: kernel.worldRevision,
            type: command.type,
            payload: command.payload,
          });
          expect(kernel.checkInvariants()).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('different seeds give different worlds; the same seed gives the same world', () => {
    const commands: ScriptedCommand[] = [
      { atMs: 0n, commandId: testUuid(1), type: 'toy.hire', payload: { name: 'Ann' } },
      { atMs: 0n, commandId: testUuid(2), type: 'toy.deliver', payload: { quantity: 30 } },
    ];
    const hashes = new Set<string>();
    for (let worldSeed = 0; worldSeed < 20; worldSeed += 1) {
      const first = run(commands, worldSeed).fingerprint;
      expect(run(commands, worldSeed).fingerprint).toEqual(first);
      hashes.add(first.stateHash);
    }
    expect(hashes.size).toBe(20);
  });
});
