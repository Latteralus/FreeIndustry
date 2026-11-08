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
 * This version writes `format-3-leased-workshop.fisave` (Step 07, save format
 * 3): a world built from the base content, a company that leased the workshop
 * at 8 Canal Street, Harlow Falls, for six months, rent paid by standing order
 * until the money ran short, one rent bill overdue, and the lease still
 * running. The format 1 and format 2 fixtures were written by the Step 04 and
 * Step 05 versions of this script (see the repository history); this build
 * can only write the current format, so it could not reproduce them anyway.
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

const NAME = 'format-3-leased-workshop';
const FIXTURE = join(import.meta.dirname, '..', 'tests', 'fixtures', 'saves', `${NAME}.fisave`);
if (existsSync(FIXTURE)) {
  throw new Error(`${FIXTURE} already exists; frozen fixtures are never regenerated`);
}

const SEED = 19_960_107;
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
// $2,600: the deposit and first month ($1,560) and two more months, but not a third.
submit('company.found', {
  legalName: 'Fixture Lease Co.',
  presidentName: 'Lee Fixture',
  startingCapitalCents: '260000',
  premises: { propertyId: 'hf-canal-8', termMonths: 6, standingOrder: true },
});
world.advanceTo(100n * MS_PER_DAY + 12n * MS_PER_HOUR);

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
    now: () => new Date('2026-11-08T12:00:00.000Z'),
    uniqueToken: () => 'fixture',
  });
  const { domain: _domain, ...kernel } = world.encodedState();
  store.write(
    'fixture',
    {
      identity: {
        worldId: '1996a0a0-0000-4000-8000-000000000003',
        createdAt: '2026-11-08T11:00:00.000Z',
        contentVersion: null,
      },
      kernel,
      domain: world.state,
      journal: world.encodedJournalFrom(1),
      fingerprint: world.fingerprint(),
      workspace: {},
      audit: [
        {
          occurredAt: '2026-11-08T11:00:00.000Z',
          simTimeMs: 0n,
          worldRevision: 0,
          kind: 'world.created',
          details: { seed: SEED, scenario: 'standard' },
        },
      ],
    },
    {
      name: 'Format 3 fixture',
      kind: 'manual',
      savedAt: '2026-11-08T12:00:00.000Z',
      appVersion: '0.1.0',
    },
  );
  mkdirSync(join(FIXTURE, '..'), { recursive: true });
  copyFileSync(store.pathOf('fixture'), FIXTURE);
  const atSave = world.fingerprint();
  // Past the end of the six-month lease: the deposit comes back.
  world.advanceTo(200n * MS_PER_DAY);
  const bigintAsText = (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value;
  console.log(
    JSON.stringify(
      {
        atSave,
        day200: world.fingerprint(),
        nowMs: kernel.nowMs,
        revision: kernel.worldRevision,
        accounts: world.state.company?.ledger.accounts,
        lease: world.state.realEstate?.leases,
      },
      bigintAsText,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
