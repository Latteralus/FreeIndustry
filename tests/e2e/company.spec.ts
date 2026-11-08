import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { WorldSnapshot } from '../../src/shared/ipc/contract';
import {
  diagnostics,
  loadSave,
  openWindow,
  saveAs,
  waitReady,
  windowFrame,
  world,
} from './support/desktop';
import { launchApp, type LaunchedApp } from './support/launch';

/**
 * Step 05 acceptance in the real app: found a company through the UI, take
 * on bills, pay one, see a payment beyond the funds refused and an overdue
 * shortfall reported, then save, quit, relaunch, load — and find the opening
 * funds, every expense and the books exactly as they were. The next week then
 * plays out identically to a session that never quit. Since Step 06 it is
 * driven through the desktop's windows and menus.
 */

async function ready(launched: LaunchedApp) {
  return waitReady(launched.page);
}

async function addObligation(
  page: Page,
  options: {
    purpose: 'Rent' | 'Security deposit';
    amount: string;
    schedule: 'Monthly' | 'Once';
    months?: string;
    terms: string;
    standingOrder: boolean;
  },
) {
  const revision = (await world(page)).worldRevision;
  const window = await diagnostics(page, 'Test obligations');
  await window.getByLabel('Purpose').selectOption({ label: options.purpose });
  await window.getByLabel('Amount ($)').fill(options.amount);
  await window.getByLabel('Schedule').selectOption({ label: options.schedule });
  if (options.months) {
    await window.getByLabel('Months').fill(options.months);
  }
  await window.getByLabel('First bill in (days)').fill('0');
  await window.getByLabel('Payment terms (days)').fill(options.terms);
  await window.getByLabel('Standing order').setChecked(options.standingOrder);
  await window.getByRole('button', { name: 'Add test obligation' }).click();
  await expect.poll(async () => (await world(page)).worldRevision).toBe(revision + 1);
}

/** Found the company, take on three obligations, pay the deposit. Same in every session. */
async function plan(page: Page) {
  const company = await openWindow(page, 'Company');
  await expect(company.getByText('No company has been founded.')).toBeVisible();
  await company.getByLabel('Company name').fill('Northgate Pressings');
  await company.getByLabel('President').fill('Dana Whitlock');
  await company.getByLabel('Starting capital ($)').fill('20,000');
  await company.getByRole('button', { name: 'Found company' }).click();
  await expect(company.getByRole('heading', { name: 'Northgate Pressings' })).toBeVisible();
  await expect(company.getByTestId('company-cash')).toHaveText('$20,000.00');
  await expect(page.getByTestId('status-cash')).toHaveText('Cash: $20,000.00');

  // A deposit billed now, payable on receipt, without a standing order: overdue at once.
  await addObligation(page, {
    purpose: 'Security deposit',
    amount: '5,000',
    schedule: 'Once',
    terms: '0',
    standingOrder: false,
  });
  const bills = await openWindow(page, 'Bills and Obligations');
  await expect(bills.getByTestId('invoice-invoice:1')).toContainText('Overdue');
  await bills.getByRole('button', { name: 'Pay invoice:1 in full' }).click();
  await expect(bills.getByTestId('invoice-invoice:1')).toContainText('Settled');
  await expect(windowFrame(page, 'Company').getByTestId('company-cash')).toHaveText('$15,000.00');

  // Monthly rent by standing order, paid five days after each bill.
  await addObligation(page, {
    purpose: 'Rent',
    amount: '1,250',
    schedule: 'Monthly',
    months: '12',
    terms: '5',
    standingOrder: true,
  });
  // A bill the company cannot cover: the standing order is refused and it goes overdue.
  await addObligation(page, {
    purpose: 'Rent',
    amount: '40,000',
    schedule: 'Once',
    terms: '0',
    standingOrder: true,
  });
}

test.describe('company books in the real app', () => {
  test('gate: found, bill, pay, refuse, save, quit, relaunch, load = the same books', async () => {
    test.setTimeout(150_000);
    const SEED = 1996;
    const profile = mkdtempSync(join(tmpdir(), 'freeindustry-e2e-company-'));
    try {
      // An uninterrupted session for comparison: the plan, then a week.
      const straight = await launchApp({ seed: SEED });
      let expected: WorldSnapshot;
      try {
        const page = await ready(straight);
        await plan(page);
        await page.getByRole('button', { name: 'End of week' }).click();
        await expect.poll(async () => (await world(page)).clock.advance).toBeNull();
        expected = await world(page);
      } finally {
        await straight.close();
      }

      // Session 1: the plan, a refused payment, then save and quit.
      const first = await launchApp({ seed: SEED, userDataDir: profile });
      let atSave: WorldSnapshot;
      try {
        const page = await ready(first);
        await plan(page);
        await expect(windowFrame(page, 'Company').getByTestId('company-shortfall')).toHaveText(
          'Overdue bills exceed the funds available by $25,000.00. Payments beyond the available funds are refused; nothing is overdrawn.',
        );
        await expect(page.getByTestId('status-alerts')).toContainText(
          'Overdue bills exceed available funds by $25,000.00',
        );
        const beforeRefusal = await world(page);
        const bills = await openWindow(page, 'Bills and Obligations');
        await bills.getByRole('button', { name: 'Pay invoice:3 in full' }).click();
        await expect(bills.getByTestId('bills-outcome')).toHaveText(
          'Rejected (COMMAND_REJECTED): Insufficient funds: $15,000.00 available, $40,000.00 needed',
        );
        expect((await world(page)).fingerprint).toEqual(beforeRefusal.fingerprint);
        // Debits: cash 15,000 + deposit 5,000 + rent 41,250; credits: payables 41,250 + capital 20,000.
        const accounts = await openWindow(page, 'Accounts');
        await expect(accounts.getByTestId('trial-debits')).toHaveText('$61,250.00');
        await expect(accounts.getByTestId('trial-credits')).toHaveText('$61,250.00');
        await saveAs(page, 'Books');
        atSave = await world(page);
      } finally {
        await first.close();
      }
      expect(atSave.company).toMatchObject({
        legalName: 'Northgate Pressings',
        president: { name: 'Dana Whitlock' },
        startingCapitalCents: '2000000',
        liquidity: {
          cashCents: '1500000',
          payablesOpenCents: '4125000',
          payablesOverdueCents: '4000000',
          overdueShortfallCents: '2500000',
        },
        trialBalance: { balanced: true },
      });

      // Session 2: same profile, another seed; load and find the same books.
      const second = await launchApp({ seed: SEED + 7, userDataDir: profile });
      try {
        const page = await ready(second);
        const company = await openWindow(page, 'Company');
        await expect(company.getByText('No company has been founded.')).toBeVisible();
        await loadSave(page, 'Books');
        const loaded = await world(page);
        expect(loaded.company).toEqual(atSave.company);
        expect(loaded.fingerprint).toEqual(atSave.fingerprint);
        await expect(company.getByTestId('company-cash')).toHaveText('$15,000.00');
        const bills = await openWindow(page, 'Bills and Obligations');
        await expect(bills.getByTestId('invoice-invoice:3')).toContainText('Overdue');
        // The week plays out exactly as in the session that never quit.
        await page.getByRole('button', { name: 'End of week' }).click();
        await expect.poll(async () => (await world(page)).clock.advance).toBeNull();
        const resumed = await world(page);
        // Same world state. (The journal hashes differ, as they must: the UI gives every
        // command a fresh random ID, so the two sessions journaled differently named commands.)
        expect(resumed.fingerprint.stateHash).toBe(expected.fingerprint.stateHash);
        expect(resumed.journal).toEqual(expected.journal);
        expect(resumed.company).toEqual(expected.company);
        expect(resumed.company?.liquidity.cashCents).toBe('1375000'); // first rent paid
      } finally {
        await second.close();
      }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
