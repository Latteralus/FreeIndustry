import { baseContent } from '../../src/catalog/base-content';
import { realEstateFor } from '../../src/catalog/content-schema';
import { foundCompany } from '../../src/domain/company';
import { placeEquipment, purchaseEquipment } from '../../src/domain/facilities';
import { formatEntityId, type AllocateId } from '../../src/domain/ids';
import { signLease } from '../../src/domain/real-estate';
import { Rejection } from '../../src/domain/rejection';
import type { FacilitiesView } from '../../src/shared/ipc/facilities';
import type { PropertyView } from '../../src/shared/ipc/real-estate';
import { facilitiesView } from '../../src/worker/facility-view';
import { realEstateView } from '../../src/worker/real-estate-view';

/**
 * Facilities read models for renderer tests, produced by the worker's own
 * projection from the bundled content and the domain's own rules (no
 * kernel: jsdom has no TextEncoder for fingerprints): a company leasing the
 * garage at 2 Canal Street (rear), with one bench installed at (0, 0) and
 * one shelving unit held by its dealer.
 */

const EPOCH = { year: 1996, month: 1, day: 1 };

const ok = <T>(result: T | Rejection): T => {
  if (result instanceof Rejection) {
    throw new Error(result.reason);
  }
  return result;
};

export function sampleGarage(): { property: PropertyView; facilities: FacilitiesView } {
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
      { legalName: 'Layout Works', presidentName: 'Sam Planner', startingCapitalCents: 5_000_000n },
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
  const bought = ok(
    purchaseEquipment(
      catalog.facilities,
      signed.company,
      { equipmentTypeId: 'steel-workbench', quantity: 1 },
      context,
    ),
  );
  const shelf = ok(
    purchaseEquipment(
      bought.facilities,
      bought.company,
      { equipmentTypeId: 'steel-shelving', quantity: 1 },
      context,
    ),
  );
  const placed = ok(
    placeEquipment(
      shelf.facilities,
      signed.realEstate,
      shelf.company,
      {
        equipmentId: 'equipment:1',
        placement: { propertyId: 'hf-canal-2', level: 0, xMm: 0, yMm: 0, rotation: 0 },
        move: false,
      },
      context,
    ),
  );
  const estateView = realEstateView(signed.realEstate, placed.company, EPOCH);
  const property = estateView.properties.find((item) => item.id === 'hf-canal-2');
  if (!property) {
    throw new Error('no garage');
  }
  return {
    property,
    facilities: facilitiesView(placed.facilities, signed.realEstate, placed.company, EPOCH),
  };
}
