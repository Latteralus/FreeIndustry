import { companyViewSchema } from '../../../src/shared/ipc/company';
import { worldSnapshotSchema } from '../../../src/shared/ipc/contract';
import { DEFAULT_EPOCH } from '../../../src/simulation/freeindustry-rules';
import { companyView } from '../../../src/worker/company-view';
import { CommandHost } from '../../../src/worker/command-host';
import { SAMPLE_COMPANY_VIEW } from '../../support/sample-company-view';
import { sampleCompanyWorld } from '../../support/sample-company-world';
import { at, companyOf, companyWorld } from '../../support/save-world';
import { testUuid } from '../../support/toy-workshop';

describe('company read model', () => {
  it('is exactly the static sample the renderer tests use', () => {
    const view = companyView(companyOf(sampleCompanyWorld()), DEFAULT_EPOCH);
    expect(companyViewSchema.parse(view)).toEqual(view);
    expect(view).toEqual(SAMPLE_COMPANY_VIEW);
  });

  it('lists open bills first, then recent settled ones; dates on the world calendar', () => {
    const view = companyView(companyOf(companyWorld()), DEFAULT_EPOCH);
    expect(view.invoices.map((invoice) => [invoice.id, invoice.status])).toEqual([
      ['invoice:3', 'overdue'],
      ['invoice:5', 'overdue'],
      ['invoice:4', 'settled'],
      ['invoice:2', 'settled'],
      ['invoice:1', 'settled'],
    ]);
    expect(at(view.invoices, 0)).toMatchObject({ issuedOn: '1996-01-06', dueOn: '1996-01-06' });
    expect(view.obligations.map((obligation) => obligation.nextBillOn)).toEqual([
      null,
      '1996-03-02',
      null,
    ]);
    expect(view.entries.total).toBe(9);
    expect(at(view.entries.recent, 0).id).toBe('entry:9');
    expect(view.trialBalance).toEqual({
      debitsCents: '2200000',
      creditsCents: '2200000',
      balanced: true,
    });
    expect(view.liquidity.overdueShortfallCents).toBe('800000');
  });

  it('reaches the renderer through the worker snapshot, which main validates', () => {
    const host = new CommandHost({
      worldInstanceId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
      seed: 3,
      faultInjectionEnabled: false,
      onThreadFault: () => undefined,
      pacer: { wallNow: () => 0 },
    });
    expect(host.snapshot().company).toBeNull();
    const outcome = host.submit({
      commandId: testUuid(1),
      worldInstanceId: host.worldInstanceId,
      expectedWorldRevision: 0,
      type: 'company.found',
      payload: { legalName: 'Snap Co', presidentName: 'Sam', startingCapitalCents: '250000' },
    });
    expect(outcome.result.ok).toBe(true);
    const snapshot = worldSnapshotSchema.parse(host.snapshot());
    expect(snapshot.company).toMatchObject({
      legalName: 'Snap Co',
      liquidity: { cashCents: '250000' },
      trialBalance: { balanced: true },
    });
  });
});
