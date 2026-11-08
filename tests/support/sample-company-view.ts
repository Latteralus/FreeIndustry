import type { CompanyView } from '../../src/shared/ipc/company';

/**
 * The company read model of `sampleCompanyWorld()` as plain data, for renderer
 * tests (jsdom cannot run the kernel). `company-view.test.ts` checks it still
 * equals the worker's real projection, so it cannot drift.
 */
export const SAMPLE_COMPANY_VIEW: CompanyView = {
  firmId: 'firm:1',
  legalName: 'Panel Works',
  president: {
    personId: 'person:1',
    name: 'Lee Panel',
  },
  foundedOn: '1996-01-01',
  financing: 'owner-funds',
  startingCapitalCents: '500000',
  liquidity: {
    cashCents: '400000',
    creditAvailableCents: '0',
    availableCents: '400000',
    payablesOpenCents: '700000',
    payablesOverdueCents: '700000',
    receivablesOpenCents: '0',
    receivablesOverdueCents: '0',
    overdueShortfallCents: '300000',
  },
  accounts: [
    {
      code: '1010',
      name: 'Cash at bank',
      type: 'asset',
      balanceCents: '400000',
    },
    {
      code: '1100',
      name: 'Accounts receivable',
      type: 'asset',
      balanceCents: '0',
    },
    {
      code: '1400',
      name: 'Security deposits paid',
      type: 'asset',
      balanceCents: '100000',
    },
    {
      code: '2000',
      name: 'Accounts payable',
      type: 'liability',
      balanceCents: '-700000',
    },
    {
      code: '3000',
      name: "Owner's capital",
      type: 'equity',
      balanceCents: '-500000',
    },
    {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      balanceCents: '0',
    },
    {
      code: '6100',
      name: 'Rent expense',
      type: 'expense',
      balanceCents: '700000',
    },
  ],
  trialBalance: {
    debitsCents: '1200000',
    creditsCents: '1200000',
    balanced: true,
  },
  entries: {
    total: 4,
    recent: [
      {
        id: 'entry:4',
        postedOn: '1996-01-01',
        atMs: '32400000',
        description: 'Payment to Diagnostic landlord: Test security deposit',
        sourceKey: 'payment:1',
        counterparty: 'Diagnostic landlord',
        lines: [
          {
            account: '2000',
            debitCents: '100000',
            creditCents: '0',
          },
          {
            account: '1010',
            debitCents: '0',
            creditCents: '100000',
          },
        ],
      },
      {
        id: 'entry:3',
        postedOn: '1996-01-01',
        atMs: '32400000',
        description: 'Test rent',
        sourceKey: 'invoice:2',
        counterparty: 'Diagnostic landlord',
        lines: [
          {
            account: '6100',
            debitCents: '700000',
            creditCents: '0',
          },
          {
            account: '2000',
            debitCents: '0',
            creditCents: '700000',
          },
        ],
      },
      {
        id: 'entry:2',
        postedOn: '1996-01-01',
        atMs: '32400000',
        description: 'Test security deposit',
        sourceKey: 'invoice:1',
        counterparty: 'Diagnostic landlord',
        lines: [
          {
            account: '1400',
            debitCents: '100000',
            creditCents: '0',
          },
          {
            account: '2000',
            debitCents: '0',
            creditCents: '100000',
          },
        ],
      },
      {
        id: 'entry:1',
        postedOn: '1996-01-01',
        atMs: '32400000',
        description: 'Opening capital from Lee Panel',
        sourceKey: 'firm:1/opening-capital',
        counterparty: 'Lee Panel',
        lines: [
          {
            account: '1010',
            debitCents: '500000',
            creditCents: '0',
          },
          {
            account: '3000',
            debitCents: '0',
            creditCents: '500000',
          },
        ],
      },
    ],
  },
  invoices: [
    {
      id: 'invoice:2',
      direction: 'payable',
      counterparty: 'Diagnostic landlord',
      description: 'Test rent',
      totalCents: '700000',
      paidCents: '0',
      outstandingCents: '700000',
      issuedOn: '1996-01-01',
      dueOn: '1996-01-01',
      status: 'overdue',
    },
    {
      id: 'invoice:1',
      direction: 'payable',
      counterparty: 'Diagnostic landlord',
      description: 'Test security deposit',
      totalCents: '100000',
      paidCents: '100000',
      outstandingCents: '0',
      issuedOn: '1996-01-01',
      dueOn: '1996-01-01',
      status: 'settled',
    },
  ],
  obligations: [
    {
      id: 'obligation:1',
      counterparty: 'Diagnostic landlord',
      purpose: 'security-deposit',
      description: 'Test security deposit',
      amountCents: '100000',
      cadence: 'once',
      occurrences: 1,
      issued: 1,
      nextBillOn: null,
      paymentTermsDays: 0,
      standingOrder: false,
    },
    {
      id: 'obligation:2',
      counterparty: 'Diagnostic landlord',
      purpose: 'rent',
      description: 'Test rent',
      amountCents: '700000',
      cadence: 'once',
      occurrences: 1,
      issued: 1,
      nextBillOn: null,
      paymentTermsDays: 0,
      standingOrder: false,
    },
  ],
};
