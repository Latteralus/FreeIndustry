import { expect, test, type Page } from '@playwright/test';
import type { ClockControl } from '../../src/shared/ipc/clock';
import type { HostSnapshot, IpcResult, WorldSnapshot } from '../../src/shared/ipc/contract';
import { diagnostics } from './support/desktop';
import { launchApp, removeUserData, type LaunchedApp } from './support/launch';

/**
 * Step 03 acceptance in the real app: the deterministic clock runs in the
 * worker, independent of the renderer; pause means zero transitions;
 * targeted advances stop where they should; and the same seed and commands
 * give the same fingerprints whatever pause/speed pattern the player uses.
 */

async function world(page: Page): Promise<WorldSnapshot> {
  const result = await page.evaluate(() => window.freeIndustry?.simulation.getSnapshot());
  if (!result?.ok || !result.value.world) {
    throw new Error(`no world: ${JSON.stringify(result)}`);
  }
  return result.value.world;
}

async function control(page: Page, request: ClockControl): Promise<IpcResult<HostSnapshot>> {
  const result = await page.evaluate(
    (value) => window.freeIndustry?.simulation.control(value),
    request,
  );
  if (!result) {
    throw new Error('bridge unavailable');
  }
  return result;
}

/** Ask for a targeted advance and wait until the worker reports it finished. */
async function advance(page: Page, until: Extract<ClockControl, { action: 'advance' }>['until']) {
  await control(page, { action: 'advance', until });
  await expect.poll(async () => (await world(page)).clock.advance, { timeout: 15_000 }).toBeNull();
  return world(page);
}

async function submit(page: Page, commandId: string, type: string, payload: unknown) {
  const current = await world(page);
  const result = await page.evaluate(
    (envelope) => window.freeIndustry?.simulation.submitCommand(envelope as never),
    {
      commandId,
      worldInstanceId: current.worldInstanceId,
      expectedWorldRevision: current.worldRevision,
      type,
      payload,
    },
  );
  expect(result, `${type} ${JSON.stringify(payload)}`).toMatchObject({ ok: true });
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

test.describe('simulation clock in the real app', () => {
  let launched: LaunchedApp;

  test.beforeEach(async () => {
    launched = await launchApp();
  });

  test.afterEach(async () => {
    await launched.close();
    removeUserData(launched);
  });

  test('controls drive simulated time; a scheduled event fires; pause stops time', async () => {
    const { page } = launched;
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    await expect(page.getByTestId('sim-date')).toHaveText('Mon 1 Jan 1996');
    await expect(page.getByTestId('sim-time')).toHaveText('00:00:00');
    await expect(page.getByTestId('sim-speed')).toHaveText('Paused');

    const window = await diagnostics(page, 'Probes');
    await window.getByLabel('Delay (simulated minutes)').fill('30');
    await window.getByRole('button', { name: 'Schedule probe' }).click();
    await expect(window.getByTestId('last-outcome')).toHaveText('Accepted at revision 1');
    await expect(window.getByTestId('probes-pending')).toHaveText('1');

    await page.getByRole('button', { name: 'Next event' }).click();
    await expect(page.getByTestId('sim-time')).toHaveText('00:30:00');
    await expect(window.getByTestId('probes-fired')).toHaveText('1');
    await expect(window.getByTestId('last-fired')).toContainText('probe at 0 d 00:30:00, token');
    await window.getByRole('tab', { name: 'World' }).click();
    await expect(window.getByTestId('sim-last-stop')).toHaveText(
      'Next event: stopped after an event',
    );

    await page.getByRole('button', { name: 'End of day' }).click();
    await expect(page.getByTestId('sim-date')).toHaveText('Tue 2 Jan 1996');
    await expect(page.getByTestId('sim-time')).toHaveText('00:00:00');

    // Run at Normal (20×): the clock visibly moves.
    await page.getByRole('button', { name: 'Normal' }).click();
    await expect(page.getByTestId('sim-speed')).toHaveText('Normal (20×)');
    await expect(page.getByTestId('sim-time')).not.toHaveText('00:00:00', { timeout: 5_000 });

    // Pause: zero simulation-time transitions.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByTestId('sim-speed')).toHaveText('Paused');
    const paused = await world(page);
    await page.waitForTimeout(600);
    const later = await world(page);
    expect(later.clock.nowMs).toBe(paused.clock.nowMs);
    expect(later.fingerprint).toEqual(paused.fingerprint);
    // Clock control is not a world command.
    expect(later.worldRevision).toBe(1);

    await launched.close();
    const messages = launched.readLog().map((entry) => String(entry['message']));
    expect(messages).toContain('Clock control');
  });

  test('clock control requests are validated before reaching the worker', async () => {
    const { page } = launched;
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    const before = await world(page);
    const result = await page.evaluate(() =>
      window.freeIndustry?.simulation.control({ action: 'setSpeed', speed: 'ludicrous' } as never),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'MALFORMED_REQUEST' } });
    expect((await world(page)).clock).toEqual(before.clock);
  });
});

test.describe('determinism across real app sessions (fixed seed)', () => {
  const SEED = 4242;

  async function session(seed: number, play: (page: Page) => Promise<void>) {
    const launched = await launchApp({ seed });
    try {
      const { page } = launched;
      await expect(page.getByTestId('worker-state')).toHaveText('Ready');
      expect((await world(page)).seed).toBe(seed);
      // The same plan, entered at time 0 while paused.
      await submit(page, uuid(1), 'diagnostics.recordProbe', { label: 'plan' });
      await submit(page, uuid(2), 'diagnostics.scheduleProbe', { label: 'a', delayMs: 600_000 });
      await submit(page, uuid(3), 'diagnostics.scheduleProbe', { label: 'b', delayMs: 7_200_000 });
      await submit(page, uuid(4), 'diagnostics.scheduleProbe', { label: 'c', delayMs: 18_000_000 });
      await play(page);
      const end = await advance(page, 'endOfDay');
      expect(end.clock.nowMs).toBe('86400000');
      return end;
    } finally {
      await launched.close();
      removeUserData(launched);
    }
  }

  test('different pause/speed patterns give identical fingerprints; another seed differs', async () => {
    test.setTimeout(120_000);
    const straight = await session(SEED, async () => {
      // Nothing: go straight to the end of the day.
    });
    const meandering = await session(SEED, async (page) => {
      await control(page, { action: 'setSpeed', speed: 'fastest' });
      await page.waitForTimeout(1_200);
      await control(page, { action: 'setSpeed', speed: 'paused' });
      await page.waitForTimeout(300);
      await advance(page, 'step');
      await advance(page, 'nextEvent');
      await control(page, { action: 'setSpeed', speed: 'normal' });
      await page.waitForTimeout(500);
      await control(page, { action: 'setSpeed', speed: 'paused' });
    });
    expect(meandering.diagnostics).toEqual(straight.diagnostics);
    expect(meandering.diagnostics.firedProbes).toBe(3);
    expect(meandering.journal).toEqual(straight.journal);
    expect(meandering.fingerprint).toEqual(straight.fingerprint);

    const otherSeed = await session(SEED + 1, async () => {
      // Same commands, different seed: the random probe tokens differ.
    });
    expect(otherSeed.fingerprint.stateHash).not.toBe(straight.fingerprint.stateHash);
    expect(otherSeed.diagnostics.lastFiredProbe?.token).not.toBe(
      straight.diagnostics.lastFiredProbe?.token,
    );
  });
});
