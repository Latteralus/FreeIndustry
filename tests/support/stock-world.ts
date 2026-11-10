import type { Stock, StockLot } from '../../src/domain/stock';
import { indexStock } from '../../src/domain/stock';
import type { FreeIndustryState } from '../../src/domain/world-state';
import { FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../src/simulation/kernel';
import { accept, leasedWorld, submit, type World } from './facility-world';

/**
 * Helpers for Step 10 stock tests: worlds from the real bundled content with
 * a company leasing premises and test deliveries through the real command,
 * and a way to write impossible stock straight into a world's state so the
 * invariants can be seen to refuse it.
 */

export interface Delivery {
  readonly productId: string;
  readonly grade: string | null;
  readonly containerTypeId: string;
  readonly containers: number;
  readonly quantityPerContainerMicro: string;
  readonly palletTypeId: string | null;
  readonly containersPerPallet: number | null;
  readonly totalCostCents: string;
}

/** Four cartons of 200 screws on one pallet for $41.60 ($0.052 a screw). */
export const SCREWS_ON_A_PALLET: Delivery = {
  productId: 'wood-screw-8-1-25',
  grade: null,
  containerTypeId: 'carton-24x16x16',
  containers: 4,
  quantityPerContainerMicro: '200000000',
  palletTypeId: 'gma-pallet',
  containersPerPallet: 4,
  totalCostCents: '4160',
};

/** One 208 L drum holding 200 L of enamel for $1,100. */
export const PAINT_IN_A_DRUM: Delivery = {
  productId: 'enamel-machine-grey',
  grade: null,
  containerTypeId: 'steel-drum-55gal',
  containers: 1,
  quantityPerContainerMicro: '200000000',
  palletTypeId: null,
  containersPerPallet: null,
  totalCostCents: '110000',
};

/** Six serialized motors loose on a pallet for $540. */
export const MOTORS_ON_A_PALLET: Delivery = {
  productId: 'motor-half-hp',
  grade: null,
  containerTypeId: 'gma-pallet',
  containers: 1,
  quantityPerContainerMicro: '6000000',
  palletTypeId: null,
  containersPerPallet: null,
  totalCostCents: '54000',
};

/** The factory at 8 Northgate Drive has two loading docks and a roller shutter: room for many deliveries. */
export const FACTORY = 'hf-ng-8';
/** The workshop at 8 Canal Street has one 3 m roller shutter. */
export const WORKSHOP = 'hf-canal-8';

export function deliver(world: World, delivery: Partial<Delivery> = {}): void {
  accept(world, 'diagnostics.deliverTestStock', { ...SCREWS_ON_A_PALLET, ...delivery });
}

export function deliveryRefusal(world: World, delivery: Partial<Delivery>): string {
  const result = submit(world, 'diagnostics.deliverTestStock', {
    ...SCREWS_ON_A_PALLET,
    ...delivery,
  });
  if (result.ok) {
    throw new Error('the delivery was accepted');
  }
  return result.error.message;
}

export function stockOf(world: World): Stock {
  const { stock } = world.state;
  if (!stock) {
    throw new Error('the world has no stock records');
  }
  return stock;
}

export function lotOf(world: World, id: string): StockLot {
  const lot = indexStock(stockOf(world)).lots.get(id);
  if (!lot) {
    throw new Error(`no lot ${id}`);
  }
  return lot;
}

/** A company leasing the factory at 8 Northgate Drive, with plenty of money. */
export function stockWorld(propertyId = FACTORY, seed = 7): World {
  return leasedWorld(propertyId, { capitalCents: '50000000', seed });
}

/** The balance of an account, or zero if the company has not opened it. */
export function balance(world: World, code: string): bigint {
  return (
    world.state.company?.ledger.accounts.find((account) => account.code === code)?.balanceCents ??
    0n
  );
}

/**
 * Restore the world with its stock slice replaced by `change(stock)`,
 * bypassing the rules. Used only to show that the invariants refuse
 * impossible stock, so it is expected to throw.
 */
export function injectStock(world: World, change: (stock: Stock) => Stock): World {
  const state: FreeIndustryState = { ...world.state, stock: change(stockOf(world)) };
  const checkpoint = world.checkpoint();
  return SimulationKernel.restore(FREEINDUSTRY_RULES, {
    state: { ...checkpoint.state, domain: FREEINDUSTRY_RULES.encodeState(state) },
    journal: checkpoint.journal,
  });
}
