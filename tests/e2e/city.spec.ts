import { expect, test, type Page } from '@playwright/test';
import { chooseMenu, loadSave, saveAs, waitReady, windowFrame, world } from './support/desktop';
import { drawnSize, sceneReady } from './support/factory';
import { launchApp, removeUserData } from './support/launch';

/**
 * Step 07 acceptance in the real app: from the main menu, start a new
 * company, examine the cities and their districts, see that properties have
 * genuinely different dimensions and costs, have a lease refused for want of
 * funds, lease a real property with the money available, and arrive at its
 * empty interior drawn to scale. Save, quit, relaunch and load: the lease and
 * the floor are back exactly. Quick Start, Options, Help and Exit work too.
 */

async function inspect(page: Page, id: string) {
  const city = windowFrame(page, 'City View');
  await city.getByTestId(`building-${id}`).click();
  return city.getByTestId('property-inspector');
}

test('lease a real property from the cityscape and enter its empty floor; it survives a restart', async () => {
  const first = await launchApp({ seed: 1996, sceneProbe: true });
  const page = await waitReady(first.page);
  const menu = windowFrame(page, 'Main Menu');
  await expect(menu.getByTestId('main-menu-status')).toHaveText(
    'No company has been founded in this world (Standard start).',
  );

  // New Company → scenario → City Selection.
  await menu.getByRole('button', { name: 'New Company…' }).click();
  const dialog = page.getByTestId('new-world-dialog');
  await expect(dialog.getByRole('radio', { name: /Standard start/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Start' }).click();
  const cities = windowFrame(page, 'City Selection');
  await expect(cities).toBeVisible();
  await expect(cities.getByTestId('city-harlow-falls')).toContainText('$11.20/h');
  await expect(cities.getByTestId('city-port-calder')).toContainText('$13.40/h');
  await cities.getByRole('button', { name: 'View Harlow Falls…' }).click();

  // The cityscape: buildings drawn at their real relative size.
  const city = windowFrame(page, 'City View');
  await expect(city.getByTestId('site-plan')).toBeVisible();
  /** Drawn width of a building's outline, in CSS pixels (geometry, without the stroke). */
  const widthOf = (id: string) =>
    city
      .getByTestId(`building-${id}`)
      .locator('polygon')
      .evaluate((polygon) => polygon.getBoundingClientRect().width);
  // A 3.0 m garage and the 36 m mill, both at 2 px a metre.
  expect(Math.round(await widthOf('hf-canal-2'))).toBe(6);
  expect(Math.round(await widthOf('hf-canal-41'))).toBe(72);

  // Genuinely different properties: dimensions, cost and services.
  let inspector = await inspect(page, 'hf-canal-2');
  await expect(inspector.getByTestId('property-area')).toHaveText('187 sq ft');
  await expect(inspector.getByTestId('property-upfront')).toContainText('$190.00');
  inspector = await inspect(page, 'hf-canal-20');
  await expect(inspector.getByTestId('property-area')).toHaveText('3,875 sq ft');
  await expect(inspector.getByTestId('property-upfront')).toContainText('$4,350.00');
  inspector = await inspect(page, 'hf-canal-12');
  await expect(inspector.getByTestId('property-status')).toContainText('Brennan Sheet Metal');
  await expect(inspector.getByRole('button', { name: 'Lease…' })).toBeDisabled();

  // A lease the capital cannot cover is refused, and nothing changes.
  await city.getByLabel('District').selectOption({ label: 'Northgate Industrial Park' });
  inspector = await inspect(page, 'hf-ng-8');
  await inspector.getByRole('button', { name: 'Lease…' }).click();
  let lease = page.getByTestId('lease-dialog');
  await lease.getByLabel('Company name').fill('Canal Works');
  await lease.getByLabel('President').fill('Jo Canal');
  await lease.getByLabel('Starting capital ($)').fill('30,000');
  const before = await world(page);
  await lease.getByRole('button', { name: 'Found company and sign lease' }).click();
  await expect(lease.getByTestId('lease-refusal')).toContainText(
    "Insufficient funds: $30,000.00 available, $39,200.00 needed (deposit $29,400.00 and the first month's rent $9,800.00)",
  );
  expect((await world(page)).fingerprint).toEqual(before.fingerprint);
  expect((await world(page)).company).toBeNull();
  await lease.getByRole('button', { name: 'Cancel' }).click();

  // Lease the workshop at 8 Canal Street with the funds available.
  await city.getByLabel('District').selectOption({ label: 'Canal Street Works' });
  inspector = await inspect(page, 'hf-canal-8');
  await inspector.getByRole('button', { name: 'Lease…' }).click();
  lease = page.getByTestId('lease-dialog');
  await lease.getByLabel('Company name').fill('Canal Works');
  await lease.getByLabel('President').fill('Jo Canal');
  await lease.getByLabel('Starting capital ($)').fill('30,000');
  await lease.getByRole('button', { name: 'Found company and sign lease' }).click();
  await expect(lease).toHaveCount(0);
  await expect(page.getByTestId('status-facility')).toHaveText('Facility: 8 Canal Street');
  await expect(page.getByTestId('status-cash')).toHaveText('Cash: $28,440.00');
  await expect(city.getByTestId('building-hf-canal-8')).toHaveAttribute('data-status', 'leased');

  // The empty interior, to scale, behind the windows.
  await chooseMenu(page, 'Window', 'Close All');
  await expect(page.getByTestId('facility-caption')).toContainText(
    '8 Canal Street · Workshop, 1,033 sq ft · Empty: no equipment, staff or stock',
  );
  // 8 m × 12 m at 10 px a metre, as the factory scene drew it.
  await sceneReady(page);
  await expect.poll(() => drawnSize(page, 'floor')).toEqual({ width: 80, height: 120 });
  const leased = await world(page);
  expect(leased.realEstate?.leases).toHaveLength(1);

  // Save, quit, relaunch with another seed, load: all of it returns.
  await saveAs(page, 'Canal Works');
  const saved = await world(page);
  await first.close();
  const second = await launchApp({ seed: 7, userDataDir: first.userDataDir });
  try {
    const again = await waitReady(second.page);
    await expect(again.getByTestId('status-facility')).toHaveText('Facility: none');
    await loadSave(again, 'Canal Works');
    await expect(again.getByTestId('status-facility')).toHaveText('Facility: 8 Canal Street');
    await expect(again.getByTestId('facility-caption')).toContainText('1,033 sq ft');
    const loaded = await world(again);
    expect(loaded.fingerprint).toEqual(saved.fingerprint);
    expect(loaded.realEstate).toEqual(saved.realEstate);
    expect(loaded.company).toEqual(saved.company);
  } finally {
    await second.close();
    removeUserData(second);
  }
});

test('Quick Start, Options, Help and Exit from the main menu', async () => {
  const launched = await launchApp({ seed: 5 });
  try {
    const page = await waitReady(launched.page);
    const menu = windowFrame(page, 'Main Menu');
    await menu.getByRole('button', { name: 'Quick Start' }).click();
    await expect(page.getByTestId('status-facility')).toHaveText('Facility: 8 Canal Street');
    await expect(menu.getByTestId('main-menu-status')).toHaveText(
      'Harlow Precision Works, 8 Canal Street.',
    );
    const company = windowFrame(page, 'Company');
    await expect(company.getByTestId('company-premises')).toContainText('8 Canal Street: leased');
    const snapshot = await world(page);
    expect(snapshot.realEstate?.scenario.id).toBe('quick-start');
    expect(snapshot.worldRevision).toBe(1);

    await menu.getByRole('button', { name: 'Options…' }).click();
    const options = page.getByTestId('options-dialog');
    await options.getByLabel('Units').selectOption('metric');
    await options.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByTestId('facility-caption')).toContainText('96.0 m²');
    expect((await world(page)).fingerprint).toEqual(snapshot.fingerprint);

    await menu.getByRole('button', { name: 'Help' }).click();
    const help = windowFrame(page, 'Help');
    await help.getByRole('tab', { name: 'Leases and rent' }).click();
    await expect(help).toContainText('Signing a lease pays the security deposit');

    // Bring the Main Menu back in front of the Help window, as a player would.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
    await page
      .getByRole('menu')
      .getByRole('menuitemradio', { name: /^\d Main Menu$/ })
      .click();
    const closed = launched.app.waitForEvent('close');
    await menu.getByRole('button', { name: 'Exit' }).click();
    await closed;
  } finally {
    await launched.close().catch(() => undefined);
    removeUserData(launched);
  }
});

test('regression: no CSP violation from the very first script, through the city windows', async () => {
  // Step 07 found Zod probing for eval while shared schemas were built at import
  // time, before the renderer entry had made Zod jitless. Listen from the start.
  const launched = await launchApp({ seed: 3 });
  try {
    const page = await waitReady(launched.page);
    await page.addInitScript(() => {
      const store = window as unknown as { cspViolations?: string[] };
      store.cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        store.cspViolations?.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
    });
    await page.reload();
    await waitReady(page);
    await chooseMenu(page, 'City', 'Cities…');
    await windowFrame(page, 'City Selection')
      .getByRole('button', { name: 'View Harlow Falls…' })
      .click();
    await windowFrame(page, 'City View').getByTestId('building-hf-canal-8').click();
    await windowFrame(page, 'City View').getByRole('button', { name: 'Lease…' }).click();
    await expect(page.getByTestId('lease-dialog')).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { cspViolations?: string[] }).cspViolations ?? null,
      ),
    ).toEqual([]);
  } finally {
    await launched.close();
    removeUserData(launched);
  }
});
