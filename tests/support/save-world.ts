import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Company } from '../../src/domain/company';
import type { FreeIndustryState } from '../../src/domain/world-state';
import type { RuntimeCompatibility } from '../../src/persistence/compatibility';
import type { SaveImage, SaveLabel } from '../../src/persistence/save-image';
import { SaveStore, type SaveStoreOptions } from '../../src/persistence/save-store';
import { DEFAULT_EPOCH, FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { KERNEL_FORMAT_VERSION, SimulationKernel } from '../../src/simulation/kernel';
import { RNG_ALGORITHM } from '../../src/simulation/rng';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../../src/domain/time';
import { testUuid } from './toy-workshop';

/**
 * Helpers for persistence tests: real FreeIndustry worlds (production rules)
 * turned into save images exactly the way the worker's SaveCoordinator does.
 */

export type World = SimulationKernel<FreeIndustryState>;

export const RUNTIME: RuntimeCompatibility = {
  kernelFormat: KERNEL_FORMAT_VERSION,
  rulesId: FREEINDUSTRY_RULES.id,
  rulesVersion: FREEINDUSTRY_RULES.version,
  rngAlgorithm: RNG_ALGORITHM,
  contentVersion: null,
};

export const WORLD_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

export function newWorld(seed = 7): World {
  return SimulationKernel.create(FREEINDUSTRY_RULES, { seed, epoch: DEFAULT_EPOCH });
}

let commandCounter = 0;

/** Submit a command at the world's current revision; throws unless accepted. */
export function command(world: World, type: string, payload: unknown): void {
  commandCounter += 1;
  const result = world.submit({
    commandId: testUuid(commandCounter),
    expectedWorldRevision: world.worldRevision,
    type,
    payload,
  });
  if (!result.ok) {
    throw new Error(`${type}: ${result.error.code} ${result.error.message}`);
  }
}

/**
 * A world mid-play: probes recorded, two scheduled probes already fired (so
 * the random stream has advanced) and two still pending.
 */
export function busyWorld(seed = 7): World {
  const world = newWorld(seed);
  command(world, 'diagnostics.recordProbe', { label: 'opening' });
  command(world, 'diagnostics.scheduleProbe', { label: 'a', delayMs: 10 * 60_000 });
  command(world, 'diagnostics.scheduleProbe', { label: 'b', delayMs: 45 * 60_000 });
  world.advanceTo(MS_PER_HOUR);
  command(world, 'diagnostics.scheduleProbe', { label: 'c', delayMs: 3 * 60 * 60_000 });
  command(world, 'diagnostics.scheduleProbe', { label: 'd', delayMs: 6 * 60 * 60_000 });
  world.advanceTo(MS_PER_HOUR + 17n * MS_PER_MINUTE);
  return world;
}

/**
 * A company mid-play (Step 05): founded at 08:00 with $10,000, a deposit paid
 * by the player, rent paid by standing order, a large rent bill overdue
 * because the funds ran short, and further bills still pending.
 */
export function companyWorld(seed = 7): World {
  const world = newWorld(seed);
  world.advanceTo(8n * MS_PER_HOUR);
  command(world, 'company.found', {
    legalName: 'Riverside Joinery',
    presidentName: 'Iris Vance',
    startingCapitalCents: '1000000',
  });
  const obligation = (overrides: Record<string, unknown>) => {
    command(world, 'diagnostics.addTestObligation', {
      purpose: 'rent',
      amountCents: '150000',
      cadence: 'monthly',
      occurrences: 6,
      firstBillInDays: 1,
      paymentTermsDays: 3,
      standingOrder: true,
      ...overrides,
    });
  };
  obligation({
    purpose: 'security-deposit',
    amountCents: '300000',
    cadence: 'once',
    occurrences: 1,
    firstBillInDays: 0,
    paymentTermsDays: 0,
    standingOrder: false,
  });
  obligation({});
  obligation({ amountCents: '600000', occurrences: 2, firstBillInDays: 5, paymentTermsDays: 0 });
  world.advanceTo(2n * MS_PER_DAY);
  command(world, 'finance.payInvoice', { invoiceId: 'invoice:1', amountCents: '300000' });
  world.advanceTo(40n * MS_PER_DAY + 3n * MS_PER_HOUR);
  return world;
}

/** The world's company; throws if none has been founded. */
export function companyOf(world: World): Company {
  const { company } = world.state;
  if (!company) {
    throw new Error('no company has been founded in this world');
  }
  return company;
}

/** Element `index` of a list; throws if it is missing (keeps tests free of `!`). */
export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no element ${index} in a list of ${list.length}`);
  }
  return item;
}

export function imageOf(world: World, journalFromSeq = 1): SaveImage {
  const { domain: _domain, ...kernel } = world.encodedState();
  return {
    identity: { worldId: WORLD_ID, createdAt: '2026-11-07T09:00:00.000Z', contentVersion: null },
    kernel,
    domain: world.state,
    journal: world.encodedJournalFrom(journalFromSeq),
    fingerprint: world.fingerprint(),
    workspace: { 'window.personnel': { x: 40, y: 60, open: true }, 'shell.theme': 'classic' },
    audit: [
      {
        occurredAt: '2026-11-07T09:00:00.000Z',
        simTimeMs: 0n,
        worldRevision: 0,
        kind: 'world.created',
        details: { seed: world.config.seed },
      },
    ],
  };
}

/** Restore an image in the kernel and insist on the saved fingerprints (as the worker does). */
export function restoreImage(image: SaveImage): World {
  const world = SimulationKernel.restore(FREEINDUSTRY_RULES, {
    state: { ...image.kernel, domain: FREEINDUSTRY_RULES.encodeState(image.domain) },
    journal: image.journal,
  });
  const fingerprint = world.fingerprint();
  if (fingerprint.stateHash !== image.fingerprint.stateHash) {
    throw new Error('the restored world does not match the saved state hash');
  }
  if (fingerprint.journalHash !== image.fingerprint.journalHash) {
    throw new Error('the restored journal does not match the saved journal hash');
  }
  return world;
}

export function label(name = 'Test save', kind: SaveLabel['kind'] = 'manual'): SaveLabel {
  return { name, kind, savedAt: '2026-11-07T12:00:00.000Z', appVersion: '0.1.0' };
}

export interface TempDir {
  readonly path: string;
  remove(): void;
}

export function tempDir(prefix = 'freeindustry-test-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

let tokenCounter = 0;

export function makeStore(directory: string, overrides: Partial<SaveStoreOptions> = {}): SaveStore {
  return new SaveStore({
    directory,
    appVersion: '0.1.0',
    runtime: RUNTIME,
    now: () => new Date('2026-11-07T12:00:00.000Z'),
    uniqueToken: () => {
      tokenCounter += 1;
      return `t${tokenCounter}`;
    },
    ...overrides,
  });
}

/** The verifier the worker uses: restore and compare fingerprints. */
export const verifyImage = (image: SaveImage): void => {
  restoreImage(image);
};
