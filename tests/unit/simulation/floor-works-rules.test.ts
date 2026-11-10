import { levelGeometry } from '../../../src/domain/facility';
import { MAX_FLOOR_ORDERS, MAX_ORDER_RECTANGLES } from '../../../src/domain/floor-works';
import { ACCOUNT, balanceOf } from '../../../src/domain/ledger';
import { cellKey } from '../../../src/domain/region';
import { MS_PER_DAY, MS_PER_HOUR } from '../../../src/domain/time';
import {
  MAX_FLOOR_ORDER_RECTANGLES,
  MAX_FLOOR_ORDERS as MAX_FLOOR_ORDERS_IPC,
} from '../../../src/shared/ipc/commands';
import { answerQuery } from '../../../src/worker/facility-view';
import {
  accept,
  buy,
  facilitiesOf,
  leasedWorld,
  placement,
  refusal,
  submit,
  worksFinishAt,
  type World,
} from '../../support/facility-world';

/**
 * Buying floor coverings (plan Step 09A; spec §5.6; DECISIONS ADR-0046,
 * ADR-0052): exact prices from exact covered area, installation and
 * removal posted separately in one balanced entry per order, refusals with
 * nothing changed, a contractor's job that takes whole days and keeps its
 * cells out of use, and complete independence from equipment and the slab.
 *
 * The garage at 2 Canal Street (hf-canal-2) is 3,000 × 5,800 mm on worn
 * concrete: 6 × 12 cells, the last row partial at 150,000 mm² each.
 */

const GARAGE = 'hf-canal-2';

function order(
  materialId: string,
  rectangles: readonly { col: number; row: number; cols: number; rows: number }[],
  propertyId = GARAGE,
  level = 0,
) {
  return { propertyId, level, materialId, rectangles: [...rectangles] };
}

function cash(world: World): bigint {
  const ledger = world.state.company?.ledger;
  if (!ledger) {
    throw new Error('no company');
  }
  return balanceOf(ledger, ACCOUNT.cash);
}

function quote(world: World, request: ReturnType<typeof order>) {
  const { facilities, realEstate, company } = world.state;
  return answerQuery({ kind: 'floorQuote', ...request }, facilities, realEstate, company, {
    nowMs: world.nowMs,
    epoch: world.config.epoch,
  });
}

function lastEntry(world: World) {
  const entries = world.state.company?.ledger.entries ?? [];
  return entries[entries.length - 1];
}

/** Exact cents of area × price per m², rounded half-up once (the rule under test, restated). */
const priced = (areaMm2: bigint, centsPerM2: bigint) =>
  (areaMm2 * centsPerM2 + 500_000n) / 1_000_000n;

describe('quoting and ordering a floor covering', () => {
  it('charges exactly the covered area: the whole garage is 17.4 m², not 72 × 0.25 m²', () => {
    const world = leasedWorld();
    const whole = order('epoxy-grey', [{ col: 0, row: 0, cols: 6, rows: 12 }]);
    const answer = quote(world, whole);
    expect(answer).toMatchObject({ kind: 'floorQuote', allowed: true, refusal: null });
    expect(answer.quote).toMatchObject({
      cells: 72,
      skippedCells: 0,
      replacedCells: 0,
      areaMm2: '17400000',
      installCents: '95700',
      removalCents: '0',
      totalCents: '95700',
      workDays: 1,
    });
    const before = cash(world);
    accept(world, 'facility.installFloorCovering', whole);
    expect(cash(world)).toBe(before - 95_700n);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('charges a partial cell only for its share', () => {
    const world = leasedWorld();
    // (5, 11) is a partial cell of 150,000 mm²: 0.15 m² × $55.00 = $8.25.
    const answer = quote(world, order('epoxy-grey', [{ col: 5, row: 11, cols: 1, rows: 1 }]));
    expect(answer.quote).toMatchObject({ cells: 1, areaMm2: '150000', totalCents: '825' });
  });

  it('posts one balanced entry per order: Dr floor-covering installation, Cr payables, then the payment', () => {
    const world = leasedWorld();
    const entriesBefore = world.state.company?.ledger.entries.length ?? 0;
    accept(
      world,
      'facility.installFloorCovering',
      order('concrete-polished', [{ col: 0, row: 0, cols: 2, rows: 2 }]),
    );
    const entries = world.state.company?.ledger.entries ?? [];
    // The contractor's invoice and its payment: cash only moves through an invoice (ADR-0031).
    expect(entries).toHaveLength(entriesBefore + 2);
    const invoiceEntry = entries[entriesBefore];
    expect(invoiceEntry?.lines).toEqual([
      { account: ACCOUNT.floorInstallation, debitCents: 4_200n, creditCents: 0n },
      { account: ACCOUNT.payables, debitCents: 0n, creditCents: 4_200n },
    ]);
    const job = facilitiesOf(world).installations[0];
    expect(job).toMatchObject({
      kind: 'installation',
      status: 'scheduled',
      cells: 4,
      areaMm2: 1_000_000n,
      installCents: 4_200n,
      removalCents: 0n,
      costCents: 4_200n,
      journalEntryId: invoiceEntry?.id,
      runs: [
        [0, 0, 2],
        [1, 0, 2],
      ],
    });
    const contractor = world.state.company?.counterparties.find(
      (party) => party.name === 'Keystone Floor Contractors',
    );
    expect(contractor?.kind).toBe('supplier');
    expect(lastEntry(world)?.lines.map((line) => line.account)).toEqual([
      ACCOUNT.payables,
      ACCOUNT.cash,
    ]);
  });

  it('a replacement takes up the installed material first, posted separately; cells already laid are skipped', () => {
    const world = leasedWorld();
    accept(
      world,
      'facility.installFloorCovering',
      order('epoxy-grey', [{ col: 0, row: 0, cols: 3, rows: 2 }]),
    );
    world.advanceTo(worksFinishAt(world));
    // Steel plate over 2 × 2 epoxy cells and 2 worn-concrete cells: a mixed order.
    const mixed = order('steel-plate', [{ col: 1, row: 0, cols: 2, rows: 3 }]);
    expect(quote(world, mixed).quote).toMatchObject({
      cells: 6,
      replacedCells: 4,
      areaMm2: '1500000',
      replacedAreaMm2: '1000000',
      removals: [{ materialId: 'epoxy-grey', cells: 4, areaMm2: '1000000' }],
      installCents: String(priced(1_500_000n, 18_000n)),
      removalCents: String(priced(1_000_000n, 1_600n)),
      totalCents: String(priced(1_500_000n, 18_000n) + priced(1_000_000n, 1_600n)),
    });
    accept(world, 'facility.installFloorCovering', mixed);
    const invoice = world.state.company?.ledger.entries.at(-2);
    expect(invoice?.lines.filter((line) => line.debitCents > 0n)).toEqual([
      { account: ACCOUNT.floorInstallation, debitCents: 27_000n, creditCents: 0n },
      { account: ACCOUNT.floorRemoval, debitCents: 1_600n, creditCents: 0n },
    ]);
    expect(facilitiesOf(world).installations[1]).toMatchObject({ kind: 'mixed', replacedCells: 4 });
    world.advanceTo(worksFinishAt(world));
    // Steel plate again over the same cells and one more: only the new cell is charged.
    const again = quote(world, order('steel-plate', [{ col: 1, row: 0, cols: 3, rows: 1 }]));
    expect(again.quote).toMatchObject({ cells: 1, skippedCells: 2, totalCents: '4500' });
    // Removal is priced from the material taken up, not the one laid.
    const back = quote(world, order('concrete-standard', [{ col: 1, row: 0, cols: 1, rows: 1 }]));
    expect(back.quote).toMatchObject({
      replacedCells: 1,
      installCents: '650',
      removalCents: '750',
    });
    expect(world.checkInvariants()).toEqual([]);
  });

  it('rounds half-up once per order: the total, with removal taking the rest', () => {
    const world = leasedWorld('hf-canal-4');
    const building = facilitiesOf(world).buildings.find((item) => item.propertyId === 'hf-canal-4');
    const property = world.state.realEstate?.properties.find((item) => item.id === 'hf-canal-4');
    const level = building?.levels[0];
    if (!building || !property || !level) {
      throw new Error('no garage');
    }
    const geometry = levelGeometry(building, property, level);
    // Every partial cell, priced alone and in one order.
    const partials = [...geometry.coverage].filter(([, area]) => area < 250_000);
    expect(partials.length).toBeGreaterThan(5);
    const rectangles = partials.map(([key]) => ({
      col: key % 4096,
      row: Math.floor(key / 4096),
      cols: 1,
      rows: 1,
    }));
    const area = partials.reduce((sum, [, cell]) => sum + BigInt(cell), 0n);
    const answer = quote(world, order('safety-hatching', rectangles, 'hf-canal-4'));
    expect(answer.quote?.areaMm2).toBe(String(area));
    expect(answer.quote?.totalCents).toBe(String(priced(area, 4_800n)));
    expect(cellKey(0, 1)).toBe(4096);
  });

  it('takes whole working days, keeps the cells out of use, and lays the material when it finishes', () => {
    const world = leasedWorld('hf-canal-20', { capitalCents: '200000000' });
    // 120 m² of steel plate at 50 m² a day: 3 days (2.4, rounded up).
    const plate = order('steel-plate', [{ col: 0, row: 0, cols: 24, rows: 20 }], 'hf-canal-20');
    expect(quote(world, plate).quote?.workDays).toBe(3);
    const orderedAt = world.nowMs;
    accept(world, 'facility.installFloorCovering', plate);
    const job = facilitiesOf(world).installations[0];
    expect(job?.completesAtMs).toBe(orderedAt + 3n * MS_PER_DAY);
    expect(facilitiesOf(world).coverings).toEqual([]);
    // Another order on those cells, or equipment standing on them, waits for the contractor.
    expect(
      refusal(
        world,
        'facility.installFloorCovering',
        order('epoxy-grey', [{ col: 5, row: 5, cols: 1, rows: 1 }], 'hf-canal-20'),
      ),
    ).toMatch(/already under floor works \(floor-installation:1\) until 1996-01-04/);
    const [bench = ''] = buy(world, 'steel-workbench');
    expect(
      refusal(world, 'equipment.install', placement(bench, 1000, 1000, 0, 'hf-canal-20')),
    ).toMatch(/floor still being laid \(floor-installation:1\)/);
    world.advanceTo(job ? job.completesAtMs - 1n : 0n);
    expect(facilitiesOf(world).coverings).toEqual([]);
    world.advanceTo(job ? job.completesAtMs : 0n);
    const laid = facilitiesOf(world);
    expect(laid.coverings).toHaveLength(480);
    expect(laid.coverings.every((cell) => cell.materialId === 'steel-plate')).toBe(true);
    expect(laid.installations[0]?.status).toBe('complete');
    const facts = world.journal.entries.flatMap((entry) => entry.facts.map((fact) => fact.type));
    expect(facts).toContain('facilities.floorCoveringOrdered');
    expect(facts).toContain('facilities.floorWorksCompleted');
    accept(world, 'equipment.install', placement(bench, 1000, 1000, 0, 'hf-canal-20'));
    expect(world.checkInvariants()).toEqual([]);
  });

  it('mixes materials in one building', () => {
    const world = leasedWorld();
    accept(
      world,
      'facility.installFloorCovering',
      order('epoxy-green', [{ col: 0, row: 0, cols: 3, rows: 6 }]),
    );
    accept(
      world,
      'facility.installFloorCovering',
      order('safety-hatching', [{ col: 3, row: 0, cols: 3, rows: 1 }]),
    );
    world.advanceTo(worksFinishAt(world));
    const materials = new Set(facilitiesOf(world).coverings.map((cell) => cell.materialId));
    expect([...materials].sort()).toEqual(['epoxy-green', 'safety-hatching']);
    expect(world.checkInvariants()).toEqual([]);
  });
});

describe('refusals change nothing', () => {
  const refused = (world: World, request: unknown, pattern: RegExp) => {
    const before = world.fingerprint();
    expect(refusal(world, 'facility.installFloorCovering', request)).toMatch(pattern);
    expect(world.fingerprint()).toEqual(before);
  };

  it('refuses cells outside the usable floor, unknown and unsold materials, and empty or useless orders', () => {
    const world = leasedWorld();
    refused(
      world,
      order('epoxy-grey', [{ col: 6, row: 0, cols: 1, rows: 1 }]),
      /not on the 6 × 12 grid/,
    );
    // An L-shaped workshop (pc-east-40): cells in the missing corner are outside.
    const shaped = leasedWorld('pc-east-40', { capitalCents: '20000000' });
    const building = facilitiesOf(shaped).buildings.find((b) => b.propertyId === 'pc-east-40');
    const property = shaped.state.realEstate?.properties.find((p) => p.id === 'pc-east-40');
    const level = building?.levels[0];
    if (!building || !property || !level) {
      throw new Error('no workshop');
    }
    const geometry = levelGeometry(building, property, level);
    const outside: { col: number; row: number }[] = [];
    for (let row = 0; row < geometry.bounds.depth / 500; row += 1) {
      for (let col = 0; col < geometry.bounds.width / 500; col += 1) {
        if (!geometry.coverage.has(cellKey(col, row))) {
          outside.push({ col, row });
        }
      }
    }
    const [corner] = outside;
    expect(corner).toBeDefined();
    if (corner) {
      refused(
        shaped,
        order('epoxy-grey', [{ ...corner, cols: 1, rows: 1 }], 'pc-east-40'),
        /1 selected cell is outside the usable floor of Ground floor, the first at/,
      );
      // A rectangle reaching into the missing corner is refused whole, not clipped by the worker.
      refused(
        shaped,
        order(
          'epoxy-grey',
          [{ col: 0, row: corner.row, cols: corner.col + 1, rows: 1 }],
          'pc-east-40',
        ),
        /outside the usable floor/,
      );
    }
    refused(
      world,
      order('gold-leaf', [{ col: 0, row: 0, cols: 1, rows: 1 }]),
      /no floor material gold-leaf/,
    );
    refused(
      world,
      order('concrete-worn', [{ col: 0, row: 0, cols: 1, rows: 1 }]),
      /existing surface only; it is not sold/,
    );
    refused(
      world,
      order('epoxy-grey', [{ col: 0, row: 0, cols: 0, rows: 1 }]),
      /Invalid|too small|expected/i,
    );
    refused(
      world,
      order('epoxy-grey', [{ col: 0, row: 0, cols: 1, rows: 1 }], 'hf-canal-8'),
      /does not occupy/,
    );
    accept(
      world,
      'facility.installFloorCovering',
      order('epoxy-grey', [{ col: 0, row: 0, cols: 1, rows: 1 }]),
    );
    world.advanceTo(worksFinishAt(world));
    refused(
      world,
      order('epoxy-grey', [{ col: 0, row: 0, cols: 1, rows: 1 }]),
      /already Industrial epoxy, grey/,
    );
  });

  it('refuses an order the funds do not cover, with the figures', () => {
    const world = leasedWorld('hf-canal-20', { capitalCents: '2000000' });
    const answer = quote(
      world,
      order('diamond-plate', [{ col: 0, row: 0, cols: 20, rows: 20 }], 'hf-canal-20'),
    );
    expect(answer.allowed).toBe(false);
    expect(answer.refusal).toMatch(/^Insufficient funds: \$[0-9,.]+ available, \$[0-9,.]+ needed/);
    const total = priced(BigInt(answer.quote?.areaMm2 ?? '0'), 21_000n);
    expect(answer.quote?.totalCents).toBe(String(total));
    const before = world.fingerprint();
    const result = submit(
      world,
      'facility.installFloorCovering',
      order('diamond-plate', [{ col: 0, row: 0, cols: 20, rows: 20 }], 'hf-canal-20'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Insufficient funds/);
      expect(result.error.details).toMatchObject({ requiredCents: String(total) });
    }
    expect(world.fingerprint()).toEqual(before);
  });

  it('refuses work the contractor would finish after the lease ends', () => {
    const world = leasedWorld();
    const lease = world.state.realEstate?.leases[0];
    world.advanceTo((lease?.endsAtMs ?? 0n) - 12n * MS_PER_HOUR);
    refused(
      world,
      order('epoxy-grey', [{ col: 0, row: 0, cols: 1, rows: 1 }]),
      /after the lease of 2 Canal Street \(rear\) ends on/,
    );
  });

  it('keeps the domain and IPC limits on rectangles and orders equal', () => {
    expect(MAX_ORDER_RECTANGLES).toBe(MAX_FLOOR_ORDER_RECTANGLES);
    expect(MAX_FLOOR_ORDERS).toBe(MAX_FLOOR_ORDERS_IPC);
  });
});

describe('floor coverings never touch equipment or the slab', () => {
  it('replacing the floor under a machine leaves its state and position identical', () => {
    const world = leasedWorld();
    const [bench = ''] = buy(world, 'steel-workbench');
    accept(world, 'equipment.install', placement(bench, 500, 1000));
    const item = () => facilitiesOf(world).equipment.find((candidate) => candidate.id === bench);
    const slab = () =>
      world.state.realEstate?.properties.find((p) => p.id === GARAGE)?.floorLoadKgPerM2;
    const before = {
      item: item(),
      slab: slab(),
      level: facilitiesOf(world).buildings.find((b) => b.propertyId === GARAGE),
    };
    accept(
      world,
      'facility.installFloorCovering',
      order('epoxy-grey', [{ col: 0, row: 0, cols: 6, rows: 12 }]),
    );
    world.advanceTo(worksFinishAt(world));
    accept(
      world,
      'facility.installFloorCovering',
      order('diamond-plate', [{ col: 0, row: 1, cols: 6, rows: 3 }]),
    );
    expect(item()).toEqual(before.item);
    world.advanceTo(worksFinishAt(world));
    expect(item()).toEqual(before.item);
    expect(slab()).toBe(before.slab);
    expect(facilitiesOf(world).buildings.find((b) => b.propertyId === GARAGE)).toBe(before.level);
    expect(world.checkInvariants()).toEqual([]);
  });

  it('a resubmitted order is answered from the journal and charged once', () => {
    const world = leasedWorld();
    const request = {
      commandId: '0000f100-0000-4000-8000-000000000001',
      expectedWorldRevision: world.worldRevision,
      type: 'facility.installFloorCovering',
      payload: order('epoxy-grey', [{ col: 0, row: 0, cols: 2, rows: 2 }]),
    };
    const first = world.submit(request);
    const balance = cash(world);
    const again = world.submit(request);
    expect(first.ok && again.ok).toBe(true);
    expect(cash(world)).toBe(balance);
    expect(facilitiesOf(world).installations).toHaveLength(1);
  });
});
