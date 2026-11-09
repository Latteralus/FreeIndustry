import { join } from 'node:path';
import { baseContent } from '../../src/catalog/base-content';
import type { CommandEnvelope, WorldSnapshot } from '../../src/shared/ipc/contract';
import { MS_PER_DAY, MS_PER_HOUR } from '../../src/domain/time';
import { CommandHost } from '../../src/worker/command-host';
import { SaveCoordinator } from '../../src/worker/save-coordinator';
import { scenarioSummaries, worldSetupFor } from '../../src/worker/world-setup';
import { makeStore, tempDir, type TempDir } from '../support/save-world';
import { testUuid } from '../support/toy-workshop';
import { must } from '../support/must';

/**
 * Specification scenario S01 — Empty garage (spec §14.2; ledger T-CITY-01,
 * T-START-01) and the Step 07 acceptance gate, in the worker's real code with
 * real SQLite files:
 *
 * - Open a new world and inspect the cityscape: cities, districts, vacant and
 *   occupied buildings, each with its own dimensions, costs and conditions.
 * - Lease a physically small property using available funds; the lease
 *   reflects the selected unit; an occupied property cannot be leased.
 * - View its correct floor geometry: a tiny floor, truly smaller than a
 *   factory's, with nothing on it — no equipment, staff or stock.
 * - Save, shut down, relaunch with another seed, load: the lease, the city's
 *   suppliers and buyers, and the books are exactly as they were, and the
 *   world continues identically.
 */

let dir: TempDir;
let ids = 0;
const newId = () => {
  ids += 1;
  return `00000000-0000-4000-a100-${ids.toString(16).padStart(12, '0')}`;
};

beforeEach(() => {
  dir = tempDir('freeindustry-s01-');
});

afterEach(() => {
  dir.remove();
});

function launch(seed: number, dataDir = dir.path) {
  const content = baseContent();
  const standard = worldSetupFor(content, 'standard');
  if (!standard) {
    throw new Error('no standard scenario');
  }
  const session: { view: () => ReturnType<SaveCoordinator['sessionView']> | null } = {
    view: () => null,
  };
  const host = new CommandHost({
    worldInstanceId: newId(),
    seed,
    epoch: standard.epoch,
    setup: standard.setup,
    scenarios: scenarioSummaries(content),
    faultInjectionEnabled: false,
    onThreadFault: () => undefined,
    pacer: { wallNow: () => 0 },
    session: () => session.view(),
  });
  const saves = new SaveCoordinator({
    host,
    store: makeStore(join(dataDir, 'saves'), { uniqueToken: newId }),
    recoveryPath: join(dataDir, 'recovery', 'session.fisave'),
    appVersion: '0.1.0',
    wallClock: () => new Date('2026-11-08T12:00:00.000Z'),
    newId,
    autosaveIntervalMs: 60_000,
    log: () => undefined,
  });
  session.view = () => saves.sessionView();
  saves.start(0);
  let n = 0;
  const submit = (type: string, payload: unknown) => {
    n += 1;
    const envelope: CommandEnvelope = {
      commandId: testUuid(40_000 + n),
      worldInstanceId: host.worldInstanceId,
      expectedWorldRevision: host.kernel.worldRevision,
      type,
      payload,
    };
    const { result, revised } = host.submit(envelope);
    if (result.ok && revised) {
      saves.afterCommand(result.value.commandId);
    }
    return result;
  };
  return { host, saves, submit };
}

function property(world: WorldSnapshot, id: string) {
  const found = world.realEstate?.properties.find((item) => item.id === id);
  if (!found) {
    throw new Error(id);
  }
  return found;
}

/** The lock-up garage at 14 Mercer Avenue, Port Calder: 3.0 m × 6.0 m, $140 a month. */
const GARAGE = 'pc-east-14';

describe('S01: an empty garage', () => {
  it('inspect the cityscape, lease a small garage, see its true empty floor, and keep it across a restart', () => {
    const first = launch(1996);
    first.saves.newWorld(must(worldSetupFor(baseContent(), 'standard')), 4242);
    let world = first.host.snapshot();

    // The cityscape: three cities, their districts, buildings vacant and occupied.
    expect(
      world.realEstate?.cities.map((city) => [city.name, city.listings, city.vacancies]),
    ).toEqual([
      ['Harlow Falls', 15, 10],
      ['Port Calder', 13, 8],
      ['Cedar Bluff', 13, 9],
    ]);
    const garage = property(world, GARAGE);
    const factory = property(world, 'pc-harbor-5');
    // Different properties have genuinely different dimensions, costs and conditions.
    expect([garage.areaMm2, garage.widthMm, garage.depthMm]).toEqual(['18000000', 3000, 6000]);
    expect([factory.areaMm2, factory.widthMm, factory.depthMm]).toEqual([
      '5400000000',
      60_000,
      90_000,
    ]);
    expect(BigInt(factory.areaMm2) / BigInt(garage.areaMm2)).toBe(300n);
    expect([garage.rentCentsPerMonth, garage.upfrontCents, garage.powerKva, garage.water]).toEqual([
      '14000',
      '28000',
      3,
      false,
    ]);
    expect([factory.rentCentsPerMonth, factory.upfrontCents, factory.powerKva]).toEqual([
      '1750000',
      '7000000',
      600,
    ]);
    // The neighbouring workshop is occupied: it cannot be leased.
    expect(property(world, 'pc-east-22')).toMatchObject({
      status: 'occupied',
      occupant: { name: 'Volta Coil & Motor' },
    });

    // Found with modest savings and lease the garage, at 09:00 on the first day.
    first.host.kernel.advanceTo(9n * MS_PER_HOUR);
    const occupied = first.submit('company.found', {
      legalName: 'Mercer Lock-up Works',
      presidentName: 'Sam Mercer',
      startingCapitalCents: '500000',
      premises: { propertyId: 'pc-east-22', termMonths: 12, standingOrder: true },
    });
    expect(!occupied.ok && occupied.error.message).toBe(
      '22 Mercer Avenue is occupied by Volta Coil & Motor',
    );
    const leased = first.submit('company.found', {
      legalName: 'Mercer Lock-up Works',
      presidentName: 'Sam Mercer',
      startingCapitalCents: '500000', // $5,000
      premises: { propertyId: GARAGE, termMonths: 12, standingOrder: true },
    });
    expect(leased.ok).toBe(true);
    world = first.host.snapshot();
    expect(property(world, GARAGE)).toMatchObject({ status: 'leased', leaseId: 'lease:1' });
    expect(world.realEstate?.leases).toEqual([
      expect.objectContaining({
        propertyId: GARAGE,
        address: '14 Mercer Avenue (rear)',
        rentCentsPerMonth: '14000',
        depositCents: '14000',
        termMonths: 12,
        status: 'active',
      }),
    ]);
    // $5,000 less the $140 deposit and the $140 first month.
    expect(world.company?.liquidity.cashCents).toBe('472000');

    // The empty facility: its floor is the garage's own outline and nothing else exists.
    expect(property(world, GARAGE).floor).toEqual([
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 6000 },
      { x: 0, y: 6000 },
    ]);
    const state = first.host.kernel.state;
    expect(Object.keys(state).sort()).toEqual([
      'company',
      'diagnostics',
      'facilities',
      'realEstate',
    ]);
    // The building's structure and the catalogs exist; the company owns nothing in it.
    expect(state.facilities?.equipment).toEqual([]);
    expect(state.facilities?.coverings).toEqual([]);
    expect(
      state.company?.ledger.accounts
        .filter((account) => account.balanceCents !== 0n)
        .map((account) => account.code),
    ).toEqual([
      '1010', // cash
      '1400', // deposit paid
      '3000', // owner's capital
      '6100', // the first month's rent
    ]);

    // Save, shut down, relaunch with another seed, load.
    first.host.kernel.advanceTo(3n * MS_PER_DAY);
    first.saves.save({ name: 'Garage', saveId: null });
    const savedId = first.saves.sessionView().savedAs?.saveId;
    const atSave = first.host.kernel.fingerprint();
    first.saves.shutdown();

    const second = launch(7);
    expect(second.host.kernel.state.company).toBeNull();
    second.saves.load(savedId ?? '');
    expect(second.host.kernel.fingerprint()).toEqual(atSave);
    const reloaded = second.host.snapshot();
    expect(reloaded.realEstate?.leases).toEqual(world.realEstate?.leases);
    expect(reloaded.realEstate?.businesses).toEqual(world.realEstate?.businesses);
    expect(reloaded.company?.liquidity).toEqual(first.host.snapshot().company?.liquidity);

    // And it continues exactly as a world that never stopped.
    // A separate profile: one FreeIndustry runs per profile (ADR-0027).
    const uninterrupted = launch(1996, join(dir.path, 'other-profile'));
    uninterrupted.saves.newWorld(must(worldSetupFor(baseContent(), 'standard')), 4242);
    uninterrupted.host.kernel.advanceTo(9n * MS_PER_HOUR);
    uninterrupted.submit('company.found', {
      legalName: 'Mercer Lock-up Works',
      presidentName: 'Sam Mercer',
      startingCapitalCents: '500000',
      premises: { propertyId: 'pc-east-22', termMonths: 12, standingOrder: true },
    });
    uninterrupted.submit('company.found', {
      legalName: 'Mercer Lock-up Works',
      presidentName: 'Sam Mercer',
      startingCapitalCents: '500000',
      premises: { propertyId: GARAGE, termMonths: 12, standingOrder: true },
    });
    const end = 120n * MS_PER_DAY;
    uninterrupted.host.kernel.advanceTo(end);
    second.host.kernel.advanceTo(end);
    expect(second.host.kernel.fingerprint().stateHash).toBe(
      uninterrupted.host.kernel.fingerprint().stateHash,
    );
    second.saves.shutdown();
    uninterrupted.saves.shutdown();
  });
});
