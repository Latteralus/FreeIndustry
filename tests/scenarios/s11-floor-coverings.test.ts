import { ACCOUNT, balanceOf } from '../../src/domain/ledger';
import { MS_PER_DAY } from '../../src/domain/time';
import { fillRects, levelRects } from '../../src/renderer/scenes/factory/floor-selection';
import { buildFloorModel } from '../../src/renderer/scenes/factory/floor-model';
import { answerQuery, facilitiesView } from '../../src/worker/facility-view';
import {
  accept,
  buy,
  facilitiesOf,
  leasedWorld,
  placement,
  refusal,
  worksFinishAt,
  type World,
} from '../support/facility-world';
import { imageOf, restoreImage } from '../support/save-world';

/**
 * Spec scenario S11 — Floor coverings (plan Step 09A), headless. In a
 * leased building with an irregular outline, a column and partial cells
 * (the L-shaped factory at 8 Northgate Drive, whose 400 mm steel columns
 * each leave four partial cells around them), place a machine, then
 * replace the floor across a rectangle and a filled area that include the
 * cells under the machine and partial cells. The quote equals the exact
 * covered area × prices; cash falls by exactly that in one balanced entry,
 * with removal shown separately from installation; outside cells and an
 * unaffordable order are refused with nothing changed; the machine and the
 * slab's load capacity are unchanged; and the floor survives save and load
 * identically. (Drawing overhead in every mode is the real-app half,
 * `tests/e2e/floor-coverings.spec.ts`.)
 */

const SITE = 'hf-ng-8';

function cash(world: World): bigint {
  const ledger = world.state.company?.ledger;
  if (!ledger) {
    throw new Error('no company');
  }
  return balanceOf(ledger, ACCOUNT.cash);
}

function quote(
  world: World,
  materialId: string,
  rectangles: readonly { col: number; row: number; cols: number; rows: number }[],
) {
  const { facilities, realEstate, company } = world.state;
  return answerQuery(
    { kind: 'floorQuote', propertyId: SITE, level: 0, materialId, rectangles: [...rectangles] },
    facilities,
    realEstate,
    company,
    { nowMs: world.nowMs, epoch: world.config.epoch },
  );
}

/** The worker's level view of the premises, as the layout tools see it. */
function levelView(world: World) {
  const view = facilitiesView(
    facilitiesOf(world),
    world.state.realEstate,
    world.state.company,
    world.config.epoch,
  );
  const level = view.premises?.levels[0];
  if (!level || !view.premises) {
    throw new Error('no premises view');
  }
  return { level, surface: view.premises.surfaceMaterialId, materials: view.floorMaterials };
}

describe('S11 — floor coverings', () => {
  it('replaces the floor across a rectangle and a fill, charged exactly, refusals changing nothing', () => {
    const world = leasedWorld(SITE, { capitalCents: '15000000' });
    const building = facilitiesOf(world).buildings.find((item) => item.propertyId === SITE);
    expect(building?.levels[0]?.floor).toHaveLength(6); // an L-shaped outline
    const slab = world.state.realEstate?.properties.find((p) => p.id === SITE)?.floorLoadKgPerM2;

    // A machine beside steel column A1 (11,800–12,200 mm each way).
    const [bench = ''] = buy(world, 'steel-workbench');
    accept(world, 'equipment.install', placement(bench, 13000, 13000, 0, SITE));
    const machine = () => facilitiesOf(world).equipment.find((item) => item.id === bench);
    const placed = machine();

    // 1. A rectangle of 10 × 10 cells around the column and under the bench, in grey epoxy.
    const rectangle = [{ col: 20, row: 20, cols: 10, rows: 10 }];
    const first = quote(world, 'epoxy-grey', rectangle);
    // 100 cells less the column's 4 × 40,000 mm²: 24.84 m² × $55.00 = $1,366.20, not 25 m².
    expect(first.quote).toMatchObject({
      cells: 100,
      areaMm2: '24840000',
      installCents: '136620',
      removalCents: '0',
      totalCents: '136620',
    });
    const before = cash(world);
    const entries = world.state.company?.ledger.entries.length ?? 0;
    accept(world, 'facility.installFloorCovering', {
      propertyId: SITE,
      level: 0,
      materialId: 'epoxy-grey',
      rectangles: rectangle,
    });
    expect(cash(world)).toBe(before - 136_620n);
    const invoice = world.state.company?.ledger.entries[entries];
    expect(invoice?.lines).toEqual([
      { account: ACCOUNT.floorInstallation, debitCents: 136_620n, creditCents: 0n },
      { account: ACCOUNT.payables, debitCents: 0n, creditCents: 136_620n },
    ]);
    world.advanceTo(worksFinishAt(world));

    // 2. A fill from inside the epoxy: the 4-connected epoxy region, under the bench and round the column.
    const view = levelView(world);
    const model = buildFloorModel(
      view.level,
      view.surface,
      view.materials.map((item) => item.id),
    );
    const filled = fillRects(model, new Set(), { col: 22, row: 22 });
    expect(filled).toEqual(rectangle);
    const second = quote(world, 'steel-plate', filled);
    // Laying 24.84 m² × $180.00 = $4,471.20; taking up 24.84 m² of epoxy × $16.00 = $397.44.
    expect(second.quote).toMatchObject({
      cells: 100,
      replacedCells: 100,
      areaMm2: '24840000',
      installCents: '447120',
      removalCents: '39744',
      totalCents: '486864',
      removals: [{ materialId: 'epoxy-grey', cells: 100, areaMm2: '24840000' }],
    });
    const beforeFill = cash(world);
    const entriesBeforeFill = world.state.company?.ledger.entries.length ?? 0;
    accept(world, 'facility.installFloorCovering', {
      propertyId: SITE,
      level: 0,
      materialId: 'steel-plate',
      rectangles: filled,
    });
    expect(cash(world)).toBe(beforeFill - 486_864n);
    // One balanced invoice entry, removal on its own account: distinguishable from installation.
    const replacement = world.state.company?.ledger.entries[entriesBeforeFill];
    expect(replacement?.lines).toEqual([
      { account: ACCOUNT.floorInstallation, debitCents: 447_120n, creditCents: 0n },
      { account: ACCOUNT.floorRemoval, debitCents: 39_744n, creditCents: 0n },
      { account: ACCOUNT.payables, debitCents: 0n, creditCents: 486_864n },
    ]);
    expect(facilitiesOf(world).installations.map((job) => job.kind)).toEqual([
      'installation',
      'replacement',
    ]);

    // 3. Refusals, with both fingerprints unchanged: a cell in the missing corner, an unaffordable order.
    const unchanged = (type: string, payload: unknown, pattern: RegExp) => {
      const fingerprint = world.fingerprint();
      expect(refusal(world, type, payload)).toMatch(pattern);
      expect(world.fingerprint()).toEqual(fingerprint);
    };
    unchanged(
      'facility.installFloorCovering',
      {
        propertyId: SITE,
        level: 0,
        materialId: 'epoxy-grey',
        rectangles: [{ col: 90, row: 120, cols: 1, rows: 1 }],
      },
      /outside the usable floor/,
    );
    world.advanceTo(worksFinishAt(world));
    const whole = levelRects(levelView(world).level);
    const unaffordable = quote(world, 'diamond-plate', whole);
    expect(unaffordable.allowed).toBe(false);
    expect(BigInt(unaffordable.quote?.totalCents ?? '0')).toBeGreaterThan(cash(world));
    unchanged(
      'facility.installFloorCovering',
      { propertyId: SITE, level: 0, materialId: 'diamond-plate', rectangles: whole },
      /^Insufficient funds: .* available, .* needed/,
    );

    // 4. The machine and the slab are exactly as they were; every covered cell is steel plate.
    expect(machine()).toEqual(placed);
    expect(world.state.realEstate?.properties.find((p) => p.id === SITE)?.floorLoadKgPerM2).toBe(
      slab,
    );
    const coverings = facilitiesOf(world).coverings;
    expect(coverings).toHaveLength(100);
    expect(new Set(coverings.map((cell) => cell.materialId))).toEqual(new Set(['steel-plate']));
    expect(world.checkInvariants()).toEqual([]);

    // 5. Save and load: identical fingerprints, then identical futures.
    const restored = restoreImage(imageOf(world));
    expect(restored.fingerprint()).toEqual(world.fingerprint());
    expect(restored.state.facilities?.coverings).toEqual(coverings);
    const later = world.nowMs + 40n * MS_PER_DAY;
    world.advanceTo(later);
    restored.advanceTo(later);
    expect(restored.fingerprint()).toEqual(world.fingerprint());
  });
});
