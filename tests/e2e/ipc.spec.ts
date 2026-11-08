import { expect, test, type Page } from '@playwright/test';
import type { HostSnapshot, IpcResult } from '../../src/shared/ipc/contract';
import { diagnostics } from './support/desktop';
import { launchApp, removeUserData, type LaunchedApp } from './support/launch';

/**
 * Step 02 acceptance: React talks to the simulation worker through validated
 * IPC; invalid requests change nothing; worker failure is explicit and
 * recoverable. Requests are sent through the real preload bridge.
 */

async function snapshot(page: Page): Promise<HostSnapshot> {
  const result = await page.evaluate(() => window.freeIndustry?.simulation.getSnapshot());
  if (!result?.ok) {
    throw new Error(`getSnapshot failed: ${JSON.stringify(result)}`);
  }
  return result.value;
}

/** Submit a raw (possibly malformed) envelope through the bridge. */
function submitRaw(page: Page, envelope: unknown): Promise<IpcResult<unknown> | undefined> {
  return page.evaluate(
    (value) =>
      window.freeIndustry?.simulation.submitCommand(value as never) as Promise<IpcResult<unknown>>,
    envelope,
  );
}

function errorCode(result: IpcResult<unknown> | undefined): string | undefined {
  return result && !result.ok ? result.error.code : undefined;
}

const COMMAND_ID = '0b9f1c2e-7a4d-4e5f-9a6b-1c2d3e4f5a6b';

test.describe('validated IPC to the simulation worker', () => {
  let launched: LaunchedApp;

  test.beforeEach(async () => {
    launched = await launchApp();
  });

  test.afterEach(async () => {
    await launched.close();
    removeUserData(launched);
  });

  test('React shows the ready worker and a probe round trip advances the revision', async () => {
    const { page } = launched;
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    const window = await diagnostics(page, 'World');
    await expect(window.getByTestId('world-revision')).toHaveText('0');

    await window.getByRole('tab', { name: 'Probes' }).click();
    await window.getByLabel('Probe label').fill('first probe');
    await window.getByRole('button', { name: 'Send probe' }).click();
    await expect(window.getByTestId('last-outcome')).toHaveText('Accepted at revision 1');
    await expect(window.getByTestId('probe-count')).toHaveText('1');
    await window.getByRole('tab', { name: 'World' }).click();
    await expect(window.getByTestId('world-revision')).toHaveText('1');

    const after = await snapshot(page);
    expect(after.worker.state).toBe('ready');
    expect(after.world?.diagnostics).toMatchObject({
      probeCount: 1,
      lastProbeLabel: 'first probe',
    });
  });

  test('malformed, unknown, unauthorized and stale requests are rejected without mutation', async () => {
    const { page } = launched;
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    const before = await snapshot(page);
    const world = before.world;
    if (!world) {
      throw new Error('worker not ready');
    }
    const valid = {
      commandId: COMMAND_ID,
      worldInstanceId: world.worldInstanceId,
      expectedWorldRevision: world.worldRevision,
      type: 'diagnostics.recordProbe',
      payload: { label: 'x' },
    };

    const cases: [string, unknown][] = [
      ['MALFORMED_REQUEST', { ...valid, commandId: 'not-a-uuid' }],
      ['MALFORMED_REQUEST', { ...valid, extra: true }],
      ['MALFORMED_REQUEST', { ...valid, expectedWorldRevision: -1 }],
      ['MALFORMED_REQUEST', 'not an object'],
      ['UNKNOWN_COMMAND', { ...valid, type: 'company.giveMoney' }],
      ['INVALID_PAYLOAD', { ...valid, payload: { label: '' } }],
      ['INVALID_PAYLOAD', { ...valid, payload: { label: 'x', extra: 1 } }],
      [
        'UNAUTHORIZED',
        { ...valid, type: 'diagnostics.injectFault', payload: { fault: 'thread-exit' } },
      ],
      ['STALE_REVISION', { ...valid, expectedWorldRevision: world.worldRevision + 1 }],
      ['STALE_REVISION', { ...valid, worldInstanceId: '11111111-2222-4333-8444-555555555555' }],
    ];
    for (const [expected, envelope] of cases) {
      expect(errorCode(await submitRaw(page, envelope)), JSON.stringify(envelope)).toBe(expected);
    }
    expect(await snapshot(page)).toEqual(before);

    // A valid command is accepted once; resubmitting it returns the receipt
    // without re-applying; reusing its ID for different contents is refused.
    const first = await submitRaw(page, valid);
    expect(first).toMatchObject({ ok: true, value: { worldRevision: 1, duplicate: false } });
    const again = await submitRaw(page, valid);
    expect(again).toMatchObject({ ok: true, value: { worldRevision: 1, duplicate: true } });
    expect(errorCode(await submitRaw(page, { ...valid, payload: { label: 'y' } }))).toBe(
      'COMMAND_ID_REUSED',
    );
    expect((await snapshot(page)).world?.worldRevision).toBe(1);
    expect((await snapshot(page)).world?.diagnostics.probeCount).toBe(1);
  });

  test('graceful shutdown stops the worker cleanly and logs it', async () => {
    await expect(launched.page.getByTestId('worker-state')).toHaveText('Ready');
    await launched.close();
    const messages = launched
      .readLog()
      .map((entry) => `${String(entry['source'])}: ${String(entry['message'])}`);
    expect(messages).toContain('worker: Worker shutting down');
    expect(messages).toContain('main: Simulation worker stopped');
    expect(messages).toContain('main: Shutdown complete');
  });
});

test.describe('worker failure (fault injection enabled)', () => {
  let launched: LaunchedApp;

  test.beforeEach(async () => {
    launched = await launchApp({ faultInjection: true });
  });

  test.afterEach(async () => {
    await launched.close();
    removeUserData(launched);
  });

  test('a handler exception is rolled back and the worker keeps running', async () => {
    const { page } = launched;
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    const before = await snapshot(page);
    const result = await submitRaw(page, {
      commandId: COMMAND_ID,
      worldInstanceId: before.world?.worldInstanceId,
      expectedWorldRevision: 0,
      type: 'diagnostics.injectFault',
      payload: { fault: 'handler-exception' },
    });
    expect(errorCode(result)).toBe('INTERNAL_ERROR');
    expect(await snapshot(page)).toEqual(before);
  });

  test('worker death fails the pending command explicitly and can be recovered', async () => {
    const { page } = launched;
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    const window = await diagnostics(page, 'Probes');
    await window.getByRole('button', { name: 'Send probe' }).click();
    await expect(window.getByTestId('probe-count')).toHaveText('1');
    const before = await snapshot(page);
    expect(before.world?.worldRevision).toBe(1);

    const result = await submitRaw(page, {
      commandId: COMMAND_ID,
      worldInstanceId: before.world?.worldInstanceId,
      expectedWorldRevision: 1,
      type: 'diagnostics.injectFault',
      payload: { fault: 'thread-exit' },
    });
    expect(errorCode(result)).toBe('WORKER_UNAVAILABLE');

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Simulation worker stopped');
    await expect(alert).toContainText('exited unexpectedly (exit code 70)');
    await expect(page.getByTestId('worker-state')).toHaveText('Failed');

    // Commands are refused while failed; nothing restarts on its own.
    const whileFailed = await submitRaw(page, {
      commandId: '2c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f',
      worldInstanceId: before.world?.worldInstanceId,
      expectedWorldRevision: 1,
      type: 'diagnostics.recordProbe',
      payload: { label: 'while failed' },
    });
    expect(errorCode(whileFailed)).toBe('WORKER_UNAVAILABLE');
    const failed = await snapshot(page);
    expect(failed.worker.state).toBe('failed');
    expect(failed.world).toBeNull();

    await page.getByRole('button', { name: 'Restart worker' }).click();
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    await expect(page.getByRole('alert')).toHaveCount(0);
    const restarted = await snapshot(page);
    expect(restarted.worker.generation).toBe(before.worker.generation + 1);
    expect(restarted.world?.worldRevision).toBe(0);
    expect(restarted.world?.worldInstanceId).not.toBe(before.world?.worldInstanceId);

    const log = launched.readLog();
    expect(
      log.some(
        (entry) =>
          entry['level'] === 'error' &&
          String(entry['message']).includes('Simulation worker exited unexpectedly'),
      ),
    ).toBe(true);
    expect(log.some((entry) => entry['message'] === 'Request lost with simulation worker')).toBe(
      true,
    );
  });

  test('an uncaught worker exception is reported as a failure', async () => {
    const { page } = launched;
    await expect(page.getByTestId('worker-state')).toHaveText('Ready');
    const before = await snapshot(page);
    await submitRaw(page, {
      commandId: COMMAND_ID,
      worldInstanceId: before.world?.worldInstanceId,
      expectedWorldRevision: 0,
      type: 'diagnostics.injectFault',
      payload: { fault: 'uncaught-exception' },
    });
    await expect(page.getByRole('alert')).toContainText(
      'Uncaught error in simulation worker: Injected uncaught worker exception',
    );
  });
});
