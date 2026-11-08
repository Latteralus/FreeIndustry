import { join } from 'node:path';
import { baseContent } from '../../../src/catalog/base-content';
import { worldSnapshotSchema, type CommandEnvelope } from '../../../src/shared/ipc/contract';
import { MS_PER_DAY, MS_PER_HOUR } from '../../../src/domain/time';
import { CommandHost } from '../../../src/worker/command-host';
import { realEstateView } from '../../../src/worker/real-estate-view';
import { SaveCoordinator } from '../../../src/worker/save-coordinator';
import { scenarioSummaries, worldSetupFor } from '../../../src/worker/world-setup';
import { estateWorld, setupFor } from '../../support/real-estate-world';
import { makeStore, tempDir, type TempDir } from '../../support/save-world';
import { testUuid } from '../../support/toy-workshop';
import { must } from '../../support/must';

/**
 * Step 07 in the worker: the first world and New Company worlds are built
 * from the bundled content, a changed world is autosaved before a new one
 * replaces it, and the real-estate read model's figures come from the
 * stored facts.
 */

let dir: TempDir;
let ids = 0;
const newId = () => {
  ids += 1;
  return `00000000-0000-4000-9100-${ids.toString(16).padStart(12, '0')}`;
};
const started: SaveCoordinator[] = [];

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  for (const coordinator of started.splice(0)) {
    coordinator.release();
  }
  dir.remove();
});

function start() {
  const content = baseContent();
  const first = setupFor('standard');
  const session: { view: () => ReturnType<SaveCoordinator['sessionView']> | null } = {
    view: () => null,
  };
  const host = new CommandHost({
    worldInstanceId: newId(),
    seed: 11,
    epoch: first.epoch,
    setup: first.setup,
    scenarios: scenarioSummaries(content),
    faultInjectionEnabled: false,
    onThreadFault: () => undefined,
    pacer: { wallNow: () => 0 },
    session: () => session.view(),
  });
  const saves = new SaveCoordinator({
    host,
    store: makeStore(join(dir.path, 'saves'), { uniqueToken: newId }),
    recoveryPath: join(dir.path, 'recovery', 'session.fisave'),
    appVersion: '0.1.0',
    wallClock: () => new Date('2026-11-08T12:00:00.000Z'),
    newId,
    autosaveIntervalMs: 60_000,
    log: () => undefined,
  });
  session.view = () => saves.sessionView();
  saves.start(0);
  started.push(saves);
  let n = 0;
  const submit = (type: string, payload: unknown) => {
    n += 1;
    const envelope: CommandEnvelope = {
      commandId: testUuid(20_000 + n),
      worldInstanceId: host.worldInstanceId,
      expectedWorldRevision: host.kernel.worldRevision,
      type,
      payload,
    };
    const { result } = host.submit(envelope);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    saves.afterCommand(result.value.commandId);
  };
  return { host, saves, submit };
}

describe('new worlds in the worker', () => {
  it('starts with the standard scenario’s cities, and its snapshot passes main’s schema', () => {
    const { host } = start();
    const snapshot = host.snapshot();
    expect(snapshot.realEstate?.scenario).toEqual({ id: 'standard', name: 'Standard start' });
    expect(snapshot.realEstate?.cities.map((city) => city.id)).toEqual([
      'harlow-falls',
      'port-calder',
      'cedar-bluff',
    ]);
    expect(snapshot.scenarios.map((scenario) => scenario.id)).toEqual([
      'standard',
      'backed',
      'quick-start',
    ]);
    expect(worldSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('replaces the world: a new instance at revision 0, autosaving the changed one first', () => {
    const { host, saves, submit } = start();
    const firstInstance = host.worldInstanceId;
    const firstWorld = saves.sessionView().worldId;
    submit('company.found', {
      legalName: 'Old Co.',
      presidentName: 'Ann Old',
      startingCapitalCents: '1000000',
    });
    saves.updateWorkspace({ key: 'desktop.layout', value: { version: 1 } });
    const setup = worldSetupFor(baseContent(), 'backed');
    if (!setup) {
      throw new Error('no backed scenario');
    }
    saves.newWorld(setup, 99);
    expect(host.worldInstanceId).not.toBe(firstInstance);
    expect(saves.sessionView()).toMatchObject({ savedAs: null, unsavedChanges: false });
    expect(saves.sessionView().worldId).not.toBe(firstWorld);
    expect(saves.workspace()).toEqual({});
    const snapshot = host.snapshot();
    expect(snapshot).toMatchObject({ worldRevision: 0, seed: 99, company: null });
    expect(snapshot.realEstate?.scenario.id).toBe('backed');
    // The changed world was kept, so starting again never silently discards play.
    expect(saves.list().map((save) => [save.name, save.kind])).toEqual([
      ['Autosave before new world', 'autosave'],
    ]);
    // An unchanged world is not autosaved again.
    saves.newWorld(setup, 100);
    expect(saves.list()).toHaveLength(1);
  });

  it('a new world plays exactly like one built directly from the same seed and content', () => {
    const { host, saves } = start();
    saves.newWorld(setupFor('quick-start'), 1234);
    expect(host.kernel.fingerprint()).toEqual(estateWorld(1234, 'quick-start').fingerprint());
  });
});

describe('the real-estate read model', () => {
  it('derives areas, rents per unit area, deposits and city figures from the stored facts', () => {
    const world = estateWorld();
    const estate = world.state.realEstate;
    if (!estate) {
      throw new Error('no real estate');
    }
    const view = realEstateView(estate, null, world.config.epoch);
    const workshop = view.properties.find((property) => property.id === 'hf-canal-8');
    // 8 m × 12 m = 96 m² = 1,033.3 sq ft at $520 a month.
    expect(workshop).toMatchObject({
      cityId: 'harlow-falls',
      areaMm2: '96000000',
      widthMm: 8000,
      depthMm: 12_000,
      rentCentsPerMonth: '52000',
      rentCentsPerSqFtYear: '604', // $6,240 a year ÷ 1,033.3 sq ft
      rentCentsPerM2Year: '6500', // $6,240 a year ÷ 96 m²
      depositCents: '104000',
      upfrontCents: '156000',
      status: 'vacant',
      occupant: null,
    });
    const occupied = view.properties.find((property) => property.id === 'hf-canal-12');
    expect(occupied).toMatchObject({
      status: 'occupied',
      occupant: { name: 'Brennan Sheet Metal', role: 'manufacturer' },
    });
    const harlow = view.cities.find((city) => city.id === 'harlow-falls');
    expect(harlow).toMatchObject({
      listings: 15,
      vacancies: 10,
      manufacturers: 3,
      suppliers: 1,
      buyers: 2,
    });
    // The average is total annual rent over total area, not an average of averages.
    expect(harlow?.averageRentCentsPerSqFtYear).toBe('347');
    expect(
      view.businesses.find((business) => business.id === 'ohio-valley-coop')?.propertyId,
    ).toBeNull();
  });

  it('shows the lease with its next rent date, and the property as leased', () => {
    const world = estateWorld();
    world.advanceTo(9n * MS_PER_HOUR);
    const result = world.submit({
      commandId: testUuid(30_001),
      expectedWorldRevision: 0,
      type: 'company.found',
      payload: {
        legalName: 'Canal Works',
        presidentName: 'Jo Canal',
        startingCapitalCents: '5000000',
        premises: { propertyId: 'hf-canal-8', termMonths: 12, standingOrder: true },
      },
    });
    expect(result.ok).toBe(true);
    world.advanceTo(10n * MS_PER_DAY);
    const view = realEstateView(
      must(world.state.realEstate),
      world.state.company,
      world.config.epoch,
    );
    expect(view.leases).toEqual([
      {
        id: 'lease:1',
        propertyId: 'hf-canal-8',
        cityId: 'harlow-falls',
        address: '8 Canal Street',
        startedOn: '1996-01-01',
        endsOn: '1997-01-01',
        termMonths: 12,
        rentCentsPerMonth: '52000',
        depositCents: '104000',
        standingOrder: true,
        status: 'active',
        endedOn: null,
        nextRentOn: '1996-02-01',
      },
    ]);
    expect(view.properties.find((property) => property.id === 'hf-canal-8')).toMatchObject({
      status: 'leased',
      leaseId: 'lease:1',
    });
  });
});
