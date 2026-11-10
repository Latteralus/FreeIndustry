/**
 * Writes a frozen save fixture into `tests/fixtures/saves/` (ADR-0027). Run
 * once, when a save format is introduced:
 *
 *   npx tsx scripts/write-save-fixture.ts
 *
 * then commit the file and paste the printed fingerprints into
 * `tests/unit/persistence/save-fixtures.test.ts`. Never regenerate an
 * existing fixture: its whole point is to be a save written by an older build.
 *
 * This version writes `format-6-stock.fisave` (Step 10, save format 6): a
 * world built from the base content, a company leasing the factory at 8
 * Northgate Drive for two years with a steel workbench installed, and four test
 * deliveries on the loading-dock aprons: screws in four cartons on a pallet,
 * six serialized motors on a pallet, a drum of enamel and a bulk bag of
 * pellets. Twenty screws and one motor have been classified as scrap. The
 * format 1–5 fixtures were written by the Step 04, 05, 07, 08 and 09A
 * versions of this script (see the repository history); this build can only
 * write the current format.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseContent } from '../src/catalog/base-content';
import { MS_PER_DAY, MS_PER_HOUR } from '../src/domain/time';
import { SaveStore } from '../src/persistence/save-store';
import { FREEINDUSTRY_RULES } from '../src/simulation/freeindustry-rules';
import { KERNEL_FORMAT_VERSION, SimulationKernel } from '../src/simulation/kernel';
import { RNG_ALGORITHM } from '../src/simulation/rng';
import { worldSetupFor } from '../src/worker/world-setup';

const NAME = 'format-6-stock';
const FIXTURE = join(import.meta.dirname, '..', 'tests', 'fixtures', 'saves', `${NAME}.fisave`);
if (existsSync(FIXTURE)) {
  throw new Error(`${FIXTURE} already exists; frozen fixtures are never regenerated`);
}

const SEED = 19_960_110;
const setup = worldSetupFor(baseContent(), 'standard');
if (!setup) {
  throw new Error('The base content has no standard scenario');
}
const world = SimulationKernel.create(
  FREEINDUSTRY_RULES,
  { seed: SEED, epoch: setup.epoch },
  setup.setup,
);
let n = 0;
const submit = (type: string, payload: unknown) => {
  n += 1;
  const result = world.submit({
    commandId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    expectedWorldRevision: world.worldRevision,
    type,
    payload,
  });
  if (!result.ok) {
    throw new Error(`${type}: ${result.error.message}`);
  }
};

world.advanceTo(10n * MS_PER_HOUR);
submit('company.found', {
  legalName: 'Fixture Stock Co.',
  presidentName: 'Lee Fixture',
  startingCapitalCents: '75000000',
  premises: { propertyId: 'hf-ng-8', termMonths: 24, standingOrder: true },
});
world.advanceTo(2n * MS_PER_DAY);
submit('equipment.purchase', { equipmentTypeId: 'steel-workbench', quantity: 1 });
submit('equipment.install', {
  equipmentId: 'equipment:1',
  propertyId: 'hf-ng-8',
  level: 0,
  xMm: 12000,
  yMm: 14000,
  rotation: 0,
});
const deliver = (fields: Record<string, unknown>) => {
  submit('diagnostics.deliverTestStock', {
    grade: null,
    palletTypeId: null,
    containersPerPallet: null,
    ...fields,
  });
};
world.advanceTo(5n * MS_PER_DAY + 9n * MS_PER_HOUR);
deliver({
  productId: 'wood-screw-8-1-25',
  containerTypeId: 'carton-24x16x16',
  containers: 4,
  quantityPerContainerMicro: '200000000',
  palletTypeId: 'gma-pallet',
  containersPerPallet: 4,
  totalCostCents: '4160',
});
deliver({
  productId: 'motor-half-hp',
  containerTypeId: 'gma-pallet',
  containers: 1,
  quantityPerContainerMicro: '6000000',
  totalCostCents: '54000',
});
world.advanceTo(12n * MS_PER_DAY + 14n * MS_PER_HOUR);
deliver({
  productId: 'enamel-machine-grey',
  containerTypeId: 'steel-drum-55gal',
  containers: 1,
  quantityPerContainerMicro: '200000000',
  totalCostCents: '110000',
});
deliver({
  productId: 'hdpe-pellets',
  containerTypeId: 'bulk-bag-1t',
  containers: 1,
  quantityPerContainerMicro: '500000000',
  totalCostCents: '42500',
});
world.advanceTo(20n * MS_PER_DAY + 11n * MS_PER_HOUR);
submit('stock.scrap', {
  lotId: 'lot:1',
  quantityMicro: '20000000',
  serials: null,
  reason: 'damaged',
});
submit('stock.scrap', {
  lotId: 'lot:5',
  quantityMicro: '1000000',
  serials: null,
  reason: 'defective',
});
world.advanceTo(20n * MS_PER_DAY + 12n * MS_PER_HOUR);

const scratch = mkdtempSync(join(tmpdir(), 'freeindustry-fixture-'));
try {
  const store = new SaveStore({
    directory: scratch,
    appVersion: '0.1.0',
    runtime: {
      kernelFormat: KERNEL_FORMAT_VERSION,
      rulesId: FREEINDUSTRY_RULES.id,
      rulesVersion: FREEINDUSTRY_RULES.version,
      rngAlgorithm: RNG_ALGORITHM,
      contentVersion: null,
    },
    now: () => new Date('2026-11-09T12:00:00.000Z'),
    uniqueToken: () => 'fixture',
  });
  const { domain: _domain, ...kernel } = world.encodedState();
  store.write(
    'fixture',
    {
      identity: {
        worldId: '1996a0a0-0000-4000-8000-000000000006',
        createdAt: '2026-11-09T11:00:00.000Z',
        contentVersion: null,
      },
      kernel,
      domain: world.state,
      journal: world.encodedJournalFrom(1),
      fingerprint: world.fingerprint(),
      workspace: {},
      audit: [
        {
          occurredAt: '2026-11-09T11:00:00.000Z',
          simTimeMs: 0n,
          worldRevision: 0,
          kind: 'world.created',
          details: { seed: SEED, scenario: 'standard' },
        },
      ],
    },
    {
      name: 'Format 6 fixture',
      kind: 'manual',
      savedAt: '2026-11-09T12:00:00.000Z',
      appVersion: '0.1.0',
    },
  );
  mkdirSync(join(FIXTURE, '..'), { recursive: true });
  copyFileSync(store.pathOf('fixture'), FIXTURE);
  const atSave = world.fingerprint();
  // Past the end of the two-year lease: the stock stays where it stands, still owned.
  world.advanceTo(800n * MS_PER_DAY);
  const bigintAsText = (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value;
  console.log(
    JSON.stringify(
      {
        atSave,
        day800: world.fingerprint(),
        nowMs: kernel.nowMs,
        revision: kernel.worldRevision,
        accounts: world.state.company?.ledger.accounts,
        lease: world.state.realEstate?.leases,
        equipment: world.state.facilities?.equipment,
        loadUnits: world.state.stock?.loadUnits,
        lots: world.state.stock?.lots.map(({ serials, ...lot }) => ({
          ...lot,
          serials: serials.length,
        })),
      },
      bigintAsText,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
