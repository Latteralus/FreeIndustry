import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandEnvelope, IpcResult, CommandReceipt } from '../../src/shared/ipc/contract';
import { companyProblems } from '../../src/domain/company-invariants';
import { ACCOUNT, balanceOf } from '../../src/domain/ledger';
import { MS_PER_DAY, MS_PER_HOUR } from '../../src/domain/time';
import { CommandHost } from '../../src/worker/command-host';
import { SaveCoordinator } from '../../src/worker/save-coordinator';
import { companyOf, makeStore, tempDir, type TempDir } from '../support/save-world';
import { testUuid } from '../support/toy-workshop';

/**
 * Step 05 acceptance gate in the worker's real code (CommandHost,
 * SaveCoordinator, SaveStore, recovery log, SQLite files):
 *
 * - All postings balance, and the books reconcile with every document.
 * - Transactions are idempotent: a resubmitted command posts nothing new.
 * - Insufficient funds are explicit: a payment beyond the funds is refused
 *   with the amounts and changes nothing; an unfundable bill becomes overdue
 *   and the shortfall is reported; cash is never overdrawn.
 * - The opening funds and every expense survive save, shutdown, reload and
 *   crash recovery with no unexplained adjustment, and the resumed world
 *   equals an uninterrupted one.
 */

let dir: TempDir;
let ids = 0;
const newId = () => {
  ids += 1;
  return `00000000-0000-4000-a000-${ids.toString(16).padStart(12, '0')}`;
};

beforeEach(() => {
  dir = tempDir('freeindustry-s05-');
});

afterEach(() => {
  dir.remove();
});

interface App {
  readonly host: CommandHost;
  readonly saves: SaveCoordinator;
}

function launch(seed: number, dataDir: string): App {
  const session: { view: () => ReturnType<SaveCoordinator['sessionView']> | null } = {
    view: () => null,
  };
  const host = new CommandHost({
    worldInstanceId: newId(),
    seed,
    faultInjectionEnabled: false,
    onThreadFault: () => undefined,
    pacer: { wallNow: () => 0 },
    session: () => session.view(),
  });
  const saves = new SaveCoordinator({
    host,
    store: makeStore(join(dataDir, 'saves'), { uniqueToken: newId }),
    recoveryPath: join(dataDir, 'recovery', 'session.fisave'),
    appVersion: '0.1.0',
    wallClock: () => new Date('2026-11-08T12:00:00.000Z'),
    newId,
    autosaveIntervalMs: 3_600_000,
    log: () => undefined,
  });
  session.view = () => saves.sessionView();
  saves.start(0);
  return { host, saves };
}

type Step =
  | { readonly kind: 'command'; readonly type: string; readonly payload: unknown }
  | { readonly kind: 'advanceTo'; readonly atMs: bigint };

/** The same step always carries the same command ID, as a replayed player would send. */
function run(app: App, step: Step, index: number): IpcResult<CommandReceipt> | null {
  if (step.kind === 'advanceTo') {
    app.host.kernel.advanceTo(step.atMs);
    return null;
  }
  const envelope: CommandEnvelope = {
    commandId: testUuid(70_000 + index),
    worldInstanceId: app.host.worldInstanceId,
    expectedWorldRevision: app.host.kernel.worldRevision,
    type: step.type,
    payload: step.payload,
  };
  const { result, revised } = app.host.submit(envelope);
  if (revised) {
    app.saves.afterCommand(envelope.commandId);
  }
  return result;
}

const day = (n: bigint, hour = 0n) => n * MS_PER_DAY + hour * MS_PER_HOUR;

const PLAN: readonly Step[] = [
  { kind: 'advanceTo', atMs: day(0n, 8n) },
  {
    kind: 'command',
    type: 'company.found',
    payload: {
      legalName: 'Gatehouse Metalcraft',
      presidentName: 'Rosa Quint',
      startingCapitalCents: '2000000', // $20,000.00
    },
  },
  {
    kind: 'command',
    type: 'diagnostics.addTestObligation',
    payload: {
      purpose: 'security-deposit',
      amountCents: '500000',
      cadence: 'once',
      occurrences: 1,
      firstBillInDays: 0,
      paymentTermsDays: 0,
      standingOrder: false,
    },
  },
  {
    kind: 'command',
    type: 'diagnostics.addTestObligation',
    payload: {
      purpose: 'rent',
      amountCents: '200000',
      cadence: 'monthly',
      occurrences: 12,
      firstBillInDays: 1,
      paymentTermsDays: 5,
      standingOrder: true,
    },
  },
  { kind: 'advanceTo', atMs: day(1n, 10n) },
  {
    kind: 'command',
    type: 'finance.payInvoice',
    payload: { invoiceId: 'invoice:1', amountCents: '500000' },
  },
  { kind: 'advanceTo', atMs: day(20n, 14n) },
  // ← saved here (index 7): January rent paid by standing order, February's bill pending.
  {
    kind: 'command',
    type: 'diagnostics.addTestObligation',
    payload: {
      purpose: 'rent',
      amountCents: '1000000',
      cadence: 'monthly',
      occurrences: 2,
      firstBillInDays: 3,
      paymentTermsDays: 0,
      standingOrder: true,
    },
  },
  { kind: 'advanceTo', atMs: day(60n) },
];

const SAVE_AT = 7;

describe('S05 / Step 05 gate: company funds and books', () => {
  it('books balance and survive save, shutdown and reload exactly; shortfalls are explicit', () => {
    // Uninterrupted session.
    const straight = launch(505, join(dir.path, 'straight'));
    PLAN.forEach((step, index) => {
      const result = run(straight, step, index);
      expect(result === null || result.ok).toBe(true);
    });

    // Interrupted session: play to day 20, save, shut down.
    const first = launch(505, join(dir.path, 'profile'));
    PLAN.slice(0, SAVE_AT).forEach((step, index) => {
      run(first, step, index);
    });
    const atSave = first.host.snapshot();
    expect(atSave.company).toMatchObject({
      legalName: 'Gatehouse Metalcraft',
      startingCapitalCents: '2000000',
      liquidity: { cashCents: '1300000', payablesOpenCents: '0' }, // 20,000 − 5,000 − 2,000
      trialBalance: { balanced: true, debitsCents: '2000000', creditsCents: '2000000' },
    });
    expect(atSave.queue.pending).toBe(1); // February's rent bill
    const saved = first.saves.save({ name: 'Day 20', saveId: null });
    first.saves.shutdown();

    // Reopen in a new worker with another seed; load; the books are exactly as saved.
    const second = launch(1, join(dir.path, 'profile'));
    second.saves.load(saved.saveId);
    const loaded = second.host.snapshot();
    expect(loaded.company).toEqual(atSave.company);
    expect(loaded.fingerprint).toEqual(atSave.fingerprint);

    // The founding resubmitted unchanged, even after the reload, is answered from the
    // journal and posts nothing; the same ID with other contents is refused.
    const founding = PLAN[1];
    if (founding?.kind !== 'command') {
      throw new Error('plan step 1 is the founding');
    }
    const envelope = {
      commandId: testUuid(70_001),
      worldInstanceId: second.host.worldInstanceId,
      expectedWorldRevision: 0,
      type: founding.type,
      payload: founding.payload,
    };
    expect(second.host.submit(envelope)).toMatchObject({
      result: { ok: true, value: { duplicate: true, worldRevision: 1 } },
      revised: false,
    });
    expect(second.host.submit({ ...envelope, expectedWorldRevision: 4 }).result).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_ID_REUSED' },
    });
    expect(second.host.snapshot().fingerprint).toEqual(atSave.fingerprint);
    PLAN.slice(SAVE_AT).forEach((step, offset) => {
      run(second, step, SAVE_AT + offset);
    });
    const overdue = companyOf(second.host.kernel).invoices.filter(
      (invoice) => invoice.overdueSinceMs !== null && invoice.paidCents < invoice.totalCents,
    );
    // Yard rent: January's $10,000 paid by standing order; February's finds $1,000 and goes overdue.
    expect(overdue.map((invoice) => invoice.totalCents)).toEqual([1_000_000n]);
    const before = second.host.kernel.fingerprint();
    const refused = run(
      second,
      {
        kind: 'command',
        type: 'finance.payInvoice',
        payload: { invoiceId: overdue[0]?.id, amountCents: '1000000' },
      },
      999,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'COMMAND_REJECTED',
        message: 'Insufficient funds: $1,000.00 available, $10,000.00 needed',
      },
    });
    expect(second.host.kernel.fingerprint()).toEqual(before);

    // The resumed world is the uninterrupted world.
    const resumed = second.host.snapshot();
    const expected = straight.host.snapshot();
    expect(resumed.fingerprint).toEqual(expected.fingerprint);
    expect(resumed.company).toEqual(expected.company);
    expect(resumed.company?.liquidity).toEqual({
      cashCents: '100000',
      creditAvailableCents: '0',
      availableCents: '100000',
      payablesOpenCents: '1000000',
      payablesOverdueCents: '1000000',
      receivablesOpenCents: '0',
      receivablesOverdueCents: '0',
      overdueShortfallCents: '900000',
    });

    // No unexplained adjustments: cash is the capital less exactly the recorded payments.
    const company = companyOf(second.host.kernel);
    expect(companyProblems(company)).toEqual([]);
    expect(second.host.kernel.checkInvariants()).toEqual([]);
    const paid = company.payments.reduce((sum, payment) => sum + payment.amountCents, 0n);
    expect(balanceOf(company.ledger, ACCOUNT.cash)).toBe(2_000_000n - paid);
    expect(company.payments.map((payment) => [payment.initiatedBy, payment.amountCents])).toEqual([
      ['player', 500_000n],
      ['standing-order', 200_000n],
      ['standing-order', 1_000_000n],
      ['standing-order', 200_000n],
    ]);
    straight.saves.release();
    second.saves.release();
  });

  it('a crash mid-session is rebuilt with the books intact from the recovery log', () => {
    const crashed = launch(77, join(dir.path, 'crashed'));
    PLAN.forEach((step, index) => {
      run(crashed, step, index);
    });
    crashed.saves.tick(1); // records a clock mark
    const lost = crashed.host.snapshot();
    crashed.saves.release(); // the process dies here, with nothing saved

    const after = join(dir.path, 'after');
    mkdirSync(join(after, 'recovery'), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(dir.path, 'crashed', 'recovery', `session.fisave${suffix}`);
      if (existsSync(source)) {
        copyFileSync(source, join(after, 'recovery', `session.fisave${suffix}`));
      }
    }
    const next = launch(2, after);
    const [recovered] = next.saves.list();
    expect(recovered).toMatchObject({ name: 'Recovered session', status: 'ready' });
    next.saves.load(recovered?.saveId ?? '');
    expect(next.host.snapshot().company).toEqual(lost.company);
    expect(next.host.snapshot().fingerprint).toEqual(lost.fingerprint);
    next.saves.release();
  });
});
