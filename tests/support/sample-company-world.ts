import { MS_PER_DAY, MS_PER_HOUR } from '../../src/domain/time';
import type { FreeIndustryState } from '../../src/domain/world-state';
import { DEFAULT_EPOCH, FREEINDUSTRY_RULES } from '../../src/simulation/freeindustry-rules';
import { SimulationKernel } from '../../src/simulation/kernel';

/**
 * The world behind `SAMPLE_COMPANY_VIEW`: a small company with a paid
 * deposit and an overdue rent bill it cannot cover. Node only (the kernel
 * hashes with TextEncoder, which jsdom lacks).
 */
export function sampleCompanyWorld(): SimulationKernel<FreeIndustryState> {
  const world = SimulationKernel.create(FREEINDUSTRY_RULES, { seed: 5, epoch: DEFAULT_EPOCH });
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
      throw new Error(result.error.message);
    }
  };
  world.advanceTo(9n * MS_PER_HOUR);
  submit('company.found', {
    legalName: 'Panel Works',
    presidentName: 'Lee Panel',
    startingCapitalCents: '500000',
  });
  const once = {
    cadence: 'once',
    occurrences: 1,
    firstBillInDays: 0,
    paymentTermsDays: 0,
    standingOrder: false,
  };
  submit('diagnostics.addTestObligation', {
    ...once,
    purpose: 'security-deposit',
    amountCents: '100000',
  });
  submit('diagnostics.addTestObligation', { ...once, purpose: 'rent', amountCents: '700000' });
  submit('finance.payInvoice', { invoiceId: 'invoice:1', amountCents: '100000' });
  world.advanceTo(MS_PER_DAY);
  return world;
}
