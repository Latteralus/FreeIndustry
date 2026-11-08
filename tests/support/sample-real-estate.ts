import { baseContent } from '../../src/catalog/base-content';
import { realEstateFor } from '../../src/catalog/content-schema';
import type { RealEstateView, ScenarioSummary } from '../../src/shared/ipc/real-estate';
import { foundCompany } from '../../src/domain/company';
import { formatEntityId, type AllocateId } from '../../src/domain/ids';
import { signLease } from '../../src/domain/real-estate';
import { Rejection } from '../../src/domain/rejection';
import { realEstateView } from '../../src/worker/real-estate-view';
import { scenarioSummaries } from '../../src/worker/world-setup';

/**
 * Real-estate read models for renderer tests, produced by the worker's own
 * projection from the bundled content and the domain's own lease rule, so
 * they cannot drift from what the app really sends. (No kernel: jsdom has
 * no TextEncoder for its fingerprints.)
 */

const EPOCH = { year: 1996, month: 1, day: 1 };

function estate() {
  const catalog = baseContent();
  const standard = catalog.scenarios.find((scenario) => scenario.id === 'standard');
  if (!standard) {
    throw new Error('no standard scenario');
  }
  return realEstateFor(catalog, standard);
}

export function sampleRealEstate(): RealEstateView {
  return realEstateView(estate(), null, EPOCH);
}

/** The view after a company leased 8 Canal Street for a year. */
export function leasedRealEstate(): RealEstateView {
  const counters = new Map<string, number>();
  const allocateId: AllocateId = (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return formatEntityId(kind, next);
  };
  const context = { nowMs: 0n, allocateId, epoch: EPOCH };
  const company = foundCompany(
    null,
    { legalName: 'Canal Works', presidentName: 'Jo Canal', startingCapitalCents: 5_000_000n },
    context,
  );
  if (company instanceof Rejection) {
    throw new Error(company.reason);
  }
  const signed = signLease(
    estate(),
    company,
    { propertyId: 'hf-canal-8', termMonths: 12, standingOrder: true },
    context,
  );
  if (signed instanceof Rejection) {
    throw new Error(signed.reason);
  }
  return realEstateView(signed.realEstate, signed.company, EPOCH);
}

export function sampleScenarios(): ScenarioSummary[] {
  return scenarioSummaries(baseContent());
}
