import type { Facilities } from '../../src/domain/facilities';
import type { FloorCovering } from '../../src/domain/floor-covering';
import { formatEntityId, type AllocateId } from '../../src/domain/ids';
import { issueInvoice, recordPayment } from '../../src/domain/invoicing';
import { ensureAccount } from '../../src/domain/ledger';
import { Rejection } from '../../src/domain/rejection';
import { MS_PER_HOUR } from '../../src/domain/time';
import type { FreeIndustryState } from '../../src/domain/world-state';
import { FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel, type SubmitResult } from '../../src/simulation/kernel';
import { estateWorld } from './real-estate-world';
import { testUuid } from './toy-workshop';

/**
 * Helpers for Step 08 tests: worlds built from the real bundled content
 * with a company leasing premises, buying and placing equipment through the
 * real commands, and (for the floor-covering layer, whose purchase is Step
 * 09A) a world with covering records injected consistently with the books.
 */

export type World = SimulationKernel<FreeIndustryState>;

let counter = 10_000;

export function submit(world: World, type: string, payload: unknown): SubmitResult {
  counter += 1;
  return world.submit({
    commandId: testUuid(counter),
    expectedWorldRevision: world.worldRevision,
    type,
    payload,
  });
}

export function accept(world: World, type: string, payload: unknown): void {
  const result = submit(world, type, payload);
  if (!result.ok) {
    throw new Error(`${type}: ${result.error.code} ${result.error.message}`);
  }
}

/** The refusal message of a command that must be rejected. */
export function refusal(world: World, type: string, payload: unknown): string {
  const result = submit(world, type, payload);
  if (result.ok) {
    throw new Error(`${type} was accepted`);
  }
  return result.error.message;
}

/** A new world from the base content, a company founded at 09:00 leasing `propertyId`. */
export function leasedWorld(
  propertyId = 'hf-canal-2',
  options: { capitalCents?: string; seed?: number; termMonths?: number } = {},
): World {
  const world = estateWorld(options.seed ?? 7);
  world.advanceTo(9n * MS_PER_HOUR);
  const property = world.state.realEstate?.properties.find((item) => item.id === propertyId);
  if (!property) {
    throw new Error(`no property ${propertyId}`);
  }
  accept(world, 'company.found', {
    legalName: 'Layout Works',
    presidentName: 'Sam Planner',
    startingCapitalCents: options.capitalCents ?? '50000000',
    premises: {
      propertyId,
      termMonths: options.termMonths ?? property.minTermMonths,
      standingOrder: true,
    },
  });
  return world;
}

export function facilitiesOf(world: World): Facilities {
  const { facilities } = world.state;
  if (!facilities) {
    throw new Error('the world has no facilities');
  }
  return facilities;
}

/** Buy `quantity` of a type; returns the new equipment IDs. */
export function buy(world: World, equipmentTypeId: string, quantity = 1): string[] {
  const before = new Set(facilitiesOf(world).equipment.map((item) => item.id));
  accept(world, 'equipment.purchase', { equipmentTypeId, quantity });
  return facilitiesOf(world)
    .equipment.filter((item) => !before.has(item.id))
    .map((item) => item.id);
}

export function placement(
  equipmentId: string,
  xMm: number,
  yMm: number,
  rotation = 0,
  propertyId = 'hf-canal-2',
  level = 0,
) {
  return { equipmentId, propertyId, level, xMm, yMm, rotation };
}

/**
 * The world with floor coverings on `cells` of its premises, recorded as one
 * installation paid from cash by an entry in the books (the shape Step 09A's
 * purchases will produce). The kernel is restored from the modified
 * checkpoint, so every invariant is checked.
 */
export function withCoverings(
  world: World,
  cells: readonly Omit<FloorCovering, 'installationId' | 'propertyId'>[],
  propertyId = 'hf-canal-2',
): World {
  const checkpoint = world.checkpoint();
  const state = world.state;
  const company = state.company;
  const facilities = facilitiesOf(world);
  const landlord = company?.counterparties.find((party) => party.kind === 'landlord');
  if (!company || !landlord) {
    throw new Error('withCoverings needs a company with a landlord');
  }
  const ids: Record<string, number> = { ...checkpoint.state.ids };
  const allocateId: AllocateId = (kind) => {
    ids[kind] = (ids[kind] ?? 0) + 1;
    return formatEntityId(kind, ids[kind]);
  };
  const context = { nowMs: world.nowMs, allocateId };
  const installationId = allocateId('floor-installation');
  const cost = 12_345n;
  const books = {
    ...company,
    ledger: ensureAccount(company.ledger, {
      code: '1650',
      name: 'Floor improvements (test)',
      type: 'asset',
    }),
  };
  const issued = issueInvoice(
    books,
    {
      direction: 'payable',
      counterpartyId: landlord.id,
      description: 'Floor covering (test)',
      lines: [{ account: '1650', description: 'Floor covering (test)', amountCents: cost }],
      dueAtMs: world.nowMs,
      obligation: null,
    },
    context,
  );
  if (issued instanceof Rejection) {
    throw new Error(issued.reason);
  }
  const paid = recordPayment(
    issued.company,
    { invoiceId: issued.invoiceId, amountCents: cost, initiatedBy: 'player' },
    context,
  );
  if (paid instanceof Rejection) {
    throw new Error(paid.reason);
  }
  const entryId = issued.company.invoices.find(
    (invoice) => invoice.id === issued.invoiceId,
  )?.entryId;
  if (!entryId) {
    throw new Error('the invoice has no entry');
  }
  const coverings = [
    ...facilities.coverings,
    ...cells.map((cell) => ({ ...cell, propertyId, installationId })),
  ].sort((a, b) => a.level - b.level || a.row - b.row || a.col - b.col);
  const next: FreeIndustryState = {
    ...state,
    company: paid.company,
    facilities: {
      ...facilities,
      coverings,
      installations: [
        ...facilities.installations,
        {
          id: installationId,
          propertyId,
          firmId: company.firmId,
          atMs: world.nowMs,
          kind: 'installation',
          cells: cells.length,
          areaMm2: BigInt(cells.length) * 250_000n,
          costCents: cost,
          journalEntryId: entryId,
        },
      ],
    },
  };
  return SimulationKernel.restore(FREEINDUSTRY_RULES, {
    state: { ...checkpoint.state, ids, domain: FREEINDUSTRY_RULES.encodeState(next) },
    journal: checkpoint.journal,
  });
}
