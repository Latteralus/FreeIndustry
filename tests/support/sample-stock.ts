import { baseContent } from '../../src/catalog/base-content';
import { realEstateFor } from '../../src/catalog/content-schema';
import { foundCompany } from '../../src/domain/company';
import { formatEntityId, type AllocateId } from '../../src/domain/ids';
import { signLease } from '../../src/domain/real-estate';
import { Rejection } from '../../src/domain/rejection';
import type { Stock } from '../../src/domain/stock';
import { receiveTestDelivery } from '../../src/domain/stock-operations';
import type { FacilitiesView } from '../../src/shared/ipc/facilities';
import type { PropertyView } from '../../src/shared/ipc/real-estate';
import type { StockRecordResult, StockView } from '../../src/shared/ipc/stock';
import { facilitiesView } from '../../src/worker/facility-view';
import { realEstateView } from '../../src/worker/real-estate-view';
import { answerStockRecord, stockView } from '../../src/worker/stock-view';

/**
 * Stock read models for renderer tests (Step 10), produced by the worker's
 * own projections from the bundled content and the domain's own rules (no
 * kernel: jsdom has no TextEncoder): a company leasing the garage at 2 Canal
 * Street (rear) with six serialized motors on a pallet delivered at its
 * roller shutter.
 */

const EPOCH = { year: 1996, month: 1, day: 1 };

const ok = <T>(result: T | Rejection): T => {
  if (result instanceof Rejection) {
    throw new Error(result.reason);
  }
  return result;
};

export interface StockedGarage {
  readonly property: PropertyView;
  readonly facilities: FacilitiesView;
  readonly stock: StockView;
  /** The worker's answer to a record query, from the same world. */
  readonly record: (id: string) => StockRecordResult;
  readonly domain: Stock;
}

export function sampleStockedGarage(): StockedGarage {
  const catalog = baseContent();
  const standard = catalog.scenarios.find((scenario) => scenario.id === 'standard');
  if (!standard) {
    throw new Error('no standard scenario');
  }
  const counters = new Map<string, number>();
  const allocateId: AllocateId = (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return formatEntityId(kind, next);
  };
  const context = { nowMs: 0n, allocateId, epoch: EPOCH };
  const founded = ok(
    foundCompany(
      null,
      { legalName: 'Stock Works', presidentName: 'Sam Stores', startingCapitalCents: 5_000_000n },
      context,
    ),
  );
  const signed = ok(
    signLease(
      realEstateFor(catalog, standard),
      founded,
      { propertyId: 'hf-canal-2', termMonths: 12, standingOrder: true },
      context,
    ),
  );
  const delivered = ok(
    receiveTestDelivery(
      catalog.stock,
      catalog.facilities,
      signed.realEstate,
      signed.company,
      {
        productId: 'motor-half-hp',
        grade: null,
        containerTypeId: 'gma-pallet',
        containers: 1,
        quantityPerContainerMicro: 6_000_000n,
        palletTypeId: null,
        containersPerPallet: null,
        totalCostCents: 54_000n,
      },
      context,
    ),
  );
  const estate = realEstateView(signed.realEstate, delivered.company, EPOCH);
  const property = estate.properties.find((item) => item.id === 'hf-canal-2');
  if (!property) {
    throw new Error('no garage');
  }
  return {
    property,
    facilities: facilitiesView(catalog.facilities, signed.realEstate, delivered.company, EPOCH),
    stock: stockView(delivered.stock, signed.realEstate, delivered.company, EPOCH),
    record: (id) =>
      answerStockRecord(
        { kind: 'stockRecord', id },
        delivered.stock,
        catalog.facilities,
        signed.realEstate,
        EPOCH,
        delivered.company,
      ),
    domain: delivered.stock,
  };
}
