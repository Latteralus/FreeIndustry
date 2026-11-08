import fc from 'fast-check';
import type { NewWorldRequest } from '../../../src/shared/ipc/real-estate';
import {
  exportFileName,
  IpcGateway,
  type DialogPort,
  type RequestSender,
  type WorkerPort,
} from '../../../src/main/ipc-gateway';
import { silentLogger } from '../../../src/main/logger';
import {
  ipcFail,
  ipcOk,
  type CommandEnvelope,
  type CommandReceipt,
  type IpcResult,
  type WorkerStatus,
  type WorldSnapshot,
} from '../../../src/shared/ipc/contract';
import type { ClockControl } from '../../../src/shared/ipc/clock';
import type {
  SaveRequest,
  SaveSummary,
  WorkspaceSettingsView,
  WorkspaceUpdate,
} from '../../../src/shared/ipc/saves';
import { sampleWorldSnapshot } from '../../support/world-snapshot';

const WORLD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const COMMAND = '0b9f1c2e-7a4d-4e5f-9a6b-1c2d3e4f5a6b';
const TRUSTED_URL = 'file:///C:/app/out/renderer/index.html';
const trusted: RequestSender = { frameUrl: TRUSTED_URL, isAppMainFrame: true };

const world: WorldSnapshot = sampleWorldSnapshot(WORLD);

const SAVE: SaveSummary = {
  saveId: 'save-1',
  status: 'ready',
  problem: null,
  name: 'Before lunch: Shop/1',
  kind: 'manual',
  savedAt: '2026-11-07T12:00:00.000Z',
  world: {
    worldId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    seed: 42,
    nowMs: '0',
    calendar: { year: 1996, month: 1, day: 1, weekday: 1, hour: 0, minute: 0, second: 0 },
    worldRevision: 0,
  },
  current: false,
};

class FakeWorker implements WorkerPort {
  status: WorkerStatus = { state: 'ready', generation: 1, failure: null };
  readonly submitted: CommandEnvelope[] = [];
  readonly controls: ClockControl[] = [];
  restarts = 0;
  submitResult: (envelope: CommandEnvelope) => Promise<IpcResult<CommandReceipt>> = (envelope) =>
    Promise.resolve(
      ipcOk({
        commandId: envelope.commandId,
        worldInstanceId: WORLD,
        worldRevision: 1,
        atMs: '0',
        duplicate: false,
      }),
    );
  getWorldSnapshot(): Promise<IpcResult<WorldSnapshot>> {
    return Promise.resolve(ipcOk(world));
  }
  submitCommand(envelope: CommandEnvelope): Promise<IpcResult<CommandReceipt>> {
    this.submitted.push(envelope);
    return this.submitResult(envelope);
  }
  control(control: ClockControl): Promise<IpcResult<WorldSnapshot>> {
    this.controls.push(control);
    return Promise.resolve(ipcOk(world));
  }
  readonly newWorlds: NewWorldRequest[] = [];
  newWorld(request: NewWorldRequest): Promise<IpcResult<WorldSnapshot>> {
    this.newWorlds.push(request);
    return Promise.resolve(ipcOk(world));
  }
  restart(): IpcResult<WorkerStatus> {
    if (this.status.state !== 'failed') {
      return ipcFail('INVALID_STATE', 'running');
    }
    this.restarts += 1;
    this.status = { state: 'starting', generation: 2, failure: null };
    return ipcOk(this.status);
  }
  readonly saveCalls: (SaveRequest | string)[] = [];
  readonly exports: { saveId: string; destinationPath: string }[] = [];
  readonly imports: string[] = [];
  readonly workspaceUpdates: WorkspaceUpdate[] = [];
  saveResult: () => Promise<IpcResult<SaveSummary>> = () => Promise.resolve(ipcOk(SAVE));
  listSaves(): Promise<IpcResult<SaveSummary[]>> {
    return Promise.resolve(ipcOk([SAVE]));
  }
  saveWorld(request: SaveRequest): Promise<IpcResult<SaveSummary>> {
    this.saveCalls.push(request);
    return this.saveResult();
  }
  loadSave(saveId: string): Promise<IpcResult<WorldSnapshot>> {
    this.saveCalls.push(saveId);
    return Promise.resolve(
      saveId === SAVE.saveId
        ? ipcOk(world)
        : ipcFail('SAVE_NOT_FOUND', 'That save no longer exists.'),
    );
  }
  exportSave(saveId: string, destinationPath: string): Promise<IpcResult<{ exported: true }>> {
    this.exports.push({ saveId, destinationPath });
    return Promise.resolve(ipcOk({ exported: true as const }));
  }
  importSave(sourcePath: string): Promise<IpcResult<SaveSummary>> {
    this.imports.push(sourcePath);
    return Promise.resolve(ipcOk({ ...SAVE, saveId: 'save-2' }));
  }
  getWorkspace(): Promise<IpcResult<WorkspaceSettingsView>> {
    return Promise.resolve(ipcOk({ settings: {} }));
  }
  setWorkspace(update: WorkspaceUpdate): Promise<IpcResult<WorkspaceSettingsView>> {
    this.workspaceUpdates.push(update);
    return Promise.resolve(ipcOk({ settings: { [update.key]: update.value } }));
  }
}

class FakeDialogs implements DialogPort {
  exportPath: string | null = 'C:/Users/Player/Documents/Shop.fisave';
  importPath: string | null = 'C:/Users/Player/Downloads/Shop.fisave';
  readonly suggested: string[] = [];
  chooseExportPath(suggestedFileName: string): Promise<string | null> {
    this.suggested.push(suggestedFileName);
    return Promise.resolve(this.exportPath);
  }
  chooseImportPath(): Promise<string | null> {
    return Promise.resolve(this.importPath);
  }
}

function setup(options: { faultInjectionEnabled?: boolean; maxInFlight?: number } = {}) {
  const worker = new FakeWorker();
  const dialogs = new FakeDialogs();
  const gateway = new IpcGateway({
    worker,
    dialogs,
    isTrustedUrl: (url) => url === TRUSTED_URL,
    faultInjectionEnabled: options.faultInjectionEnabled ?? false,
    logger: silentLogger,
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
  });
  return { worker, gateway, dialogs };
}

const envelope = {
  commandId: COMMAND,
  worldInstanceId: WORLD,
  expectedWorldRevision: 0,
  type: 'diagnostics.recordProbe',
  payload: { label: 'x' },
};

function submit(envelopeValue: unknown) {
  return { protocolVersion: 1, method: 'simulation.submitCommand', envelope: envelopeValue };
}

function codeOf(result: IpcResult<unknown>): string {
  return result.ok ? 'OK' : result.error.code;
}

describe('IpcGateway', () => {
  it('forwards a valid command to the worker', async () => {
    const { gateway, worker } = setup();
    const result = await gateway.handle(trusted, submit(envelope));
    expect(codeOf(result)).toBe('OK');
    expect(worker.submitted).toEqual([envelope]);
  });

  it('returns a host snapshot that combines worker status and world', async () => {
    const { gateway } = setup();
    await expect(
      gateway.handle(trusted, { protocolVersion: 1, method: 'simulation.getSnapshot' }),
    ).resolves.toEqual({
      ok: true,
      value: { worker: { state: 'ready', generation: 1, failure: null }, world },
    });
  });

  it('returns worker status with no world when the worker is not ready', async () => {
    const { gateway, worker } = setup();
    worker.status = {
      state: 'failed',
      generation: 1,
      failure: { message: 'gone', occurredAt: 't' },
    };
    await expect(
      gateway.handle(trusted, { protocolVersion: 1, method: 'simulation.getSnapshot' }),
    ).resolves.toEqual({ ok: true, value: { worker: worker.status, world: null } });
  });

  it.each<[string, RequestSender]>([
    ['another window', { frameUrl: TRUSTED_URL, isAppMainFrame: false }],
    ['a foreign page', { frameUrl: 'https://example.com/', isAppMainFrame: true }],
    ['a destroyed frame', { frameUrl: undefined, isAppMainFrame: true }],
  ])('refuses requests from %s', async (_name, sender) => {
    const { gateway, worker } = setup();
    expect(codeOf(await gateway.handle(sender, submit(envelope)))).toBe('UNAUTHORIZED');
    expect(worker.submitted).toEqual([]);
  });

  it.each<[unknown, string]>([
    [null, 'MALFORMED_REQUEST'],
    ['simulation.getSnapshot', 'MALFORMED_REQUEST'],
    [{ method: 'simulation.getSnapshot' }, 'UNSUPPORTED_PROTOCOL'],
    [{ protocolVersion: 2, method: 'simulation.getSnapshot' }, 'UNSUPPORTED_PROTOCOL'],
    [{ protocolVersion: 1, method: 'fs.readFile', path: 'C:/Windows' }, 'MALFORMED_REQUEST'],
    [{ protocolVersion: 1, method: 'simulation.getSnapshot', extra: 1 }, 'MALFORMED_REQUEST'],
    [submit({ ...envelope, commandId: 'x' }), 'MALFORMED_REQUEST'],
    [submit({ ...envelope, type: 'company.giveMoney' }), 'UNKNOWN_COMMAND'],
    [submit({ ...envelope, type: '__proto__' }), 'UNKNOWN_COMMAND'],
    [submit({ ...envelope, payload: { label: 7 } }), 'INVALID_PAYLOAD'],
    [
      submit({ ...envelope, type: 'diagnostics.injectFault', payload: { fault: 'thread-exit' } }),
      'UNAUTHORIZED',
    ],
    // Money is whole cents as a canonical decimal string, never a float or a number.
    ...['12.50', '-500', '0', '0100', '1e6', '100000000000001'].map((startingCapitalCents) => [
      submit({
        ...envelope,
        type: 'company.found',
        payload: { legalName: 'Acme', presidentName: 'Ada', startingCapitalCents },
      }),
      'INVALID_PAYLOAD',
    ]),
    [
      submit({
        ...envelope,
        type: 'company.found',
        payload: { legalName: 'Acme', presidentName: 'Ada', startingCapitalCents: 500000 },
      }),
      'INVALID_PAYLOAD',
    ],
    [
      submit({
        ...envelope,
        type: 'finance.payInvoice',
        payload: { invoiceId: 'payment:1', amountCents: '100' },
      }),
      'INVALID_PAYLOAD',
    ],
    [
      submit({
        ...envelope,
        type: 'diagnostics.addTestObligation',
        payload: {
          purpose: 'rent',
          amountCents: '100',
          cadence: 'weekly',
          occurrences: 1,
          firstBillInDays: 0,
          paymentTermsDays: 0,
          standingOrder: true,
        },
      }),
      'INVALID_PAYLOAD',
    ],
  ] as [unknown, string][])('rejects %j with %s before reaching the worker', async (raw, code) => {
    const { gateway, worker } = setup();
    expect(codeOf(await gateway.handle(trusted, raw))).toBe(code);
    expect(worker.submitted).toEqual([]);
  });

  it('allows fault injection only when enabled', async () => {
    const { gateway, worker } = setup({ faultInjectionEnabled: true });
    const fault = submit({
      ...envelope,
      type: 'diagnostics.injectFault',
      payload: { fault: 'thread-exit' },
    });
    expect(codeOf(await gateway.handle(trusted, fault))).toBe('OK');
    expect(worker.submitted).toHaveLength(1);
  });

  it('refuses work beyond the in-flight limit without forwarding it', async () => {
    const { gateway, worker } = setup({ maxInFlight: 2 });
    const release: (() => void)[] = [];
    worker.submitResult = (sent) =>
      new Promise((resolve) => {
        release.push(() => {
          resolve(
            ipcOk({
              commandId: sent.commandId,
              worldInstanceId: WORLD,
              worldRevision: 1,
              atMs: '0',
              duplicate: false,
            }),
          );
        });
      });
    const first = gateway.handle(trusted, submit(envelope));
    const second = gateway.handle(trusted, submit(envelope));
    expect(codeOf(await gateway.handle(trusted, submit(envelope)))).toBe('BUSY');
    expect(worker.submitted).toHaveLength(2);
    for (const done of release) {
      done();
    }
    expect((await Promise.all([first, second])).map(codeOf)).toEqual(['OK', 'OK']);
    // Capacity is released once requests finish.
    worker.submitResult = new FakeWorker().submitResult;
    expect(codeOf(await gateway.handle(trusted, submit(envelope)))).toBe('OK');
  });

  it('restarts only through the worker policy', async () => {
    const { gateway, worker } = setup();
    const restart = { protocolVersion: 1, method: 'simulation.restartWorker' };
    expect(codeOf(await gateway.handle(trusted, restart))).toBe('INVALID_STATE');
    worker.status = {
      state: 'failed',
      generation: 1,
      failure: { message: 'gone', occurredAt: 't' },
    };
    expect(codeOf(await gateway.handle(trusted, restart))).toBe('OK');
    expect(worker.restarts).toBe(1);
  });

  it('forwards valid clock control and answers with a host snapshot', async () => {
    const { gateway, worker } = setup();
    const control = {
      protocolVersion: 1,
      method: 'simulation.control',
      control: { action: 'setSpeed', speed: 'fastest' },
    };
    expect(await gateway.handle(trusted, control)).toEqual({
      ok: true,
      value: { worker: worker.status, world },
    });
    expect(worker.controls).toEqual([{ action: 'setSpeed', speed: 'fastest' }]);
  });

  it.each<[string, unknown]>([
    ['an unknown speed', { action: 'setSpeed', speed: 'ludicrous' }],
    ['an unknown target', { action: 'advance', until: 'endOfYear' }],
    ['an unknown action', { action: 'rewind' }],
    ['extra fields', { action: 'advance', until: 'step', count: 1000 }],
    ['no control', undefined],
  ])('refuses clock control with %s', async (_name, control) => {
    const { gateway, worker } = setup();
    const raw = { protocolVersion: 1, method: 'simulation.control', control };
    expect(codeOf(await gateway.handle(trusted, raw))).toBe('MALFORMED_REQUEST');
    expect(worker.controls).toEqual([]);
  });

  it('never throws, even if the worker port does', async () => {
    const { gateway, worker } = setup();
    worker.submitResult = () => Promise.reject(new Error('port exploded'));
    expect(codeOf(await gateway.handle(trusted, submit(envelope)))).toBe('INTERNAL_ERROR');
  });

  it('property: arbitrary input never reaches the worker unless it is a valid request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (raw) => {
        const { gateway, worker } = setup();
        const result = await gateway.handle(trusted, raw);
        expect(result.ok).toBe(false);
        expect(worker.submitted).toEqual([]);
        expect(worker.controls).toEqual([]);
      }),
    );
  });

  describe('saves and workspace', () => {
    const request = (method: string, extra: Record<string, unknown> = {}) => ({
      protocolVersion: 1,
      method,
      ...extra,
    });

    it('lists, saves and loads through the worker; a load answers with a host snapshot', async () => {
      const { gateway, worker } = setup();
      await expect(gateway.handle(trusted, request('saves.list'))).resolves.toEqual(ipcOk([SAVE]));
      const save = request('saves.save', { request: { name: 'Shop', saveId: null } });
      await expect(gateway.handle(trusted, save)).resolves.toEqual(ipcOk(SAVE));
      await expect(
        gateway.handle(trusted, request('saves.load', { saveId: 'save-1' })),
      ).resolves.toEqual(ipcOk({ worker: worker.status, world }));
      expect(
        codeOf(await gateway.handle(trusted, request('saves.load', { saveId: 'save-9' }))),
      ).toBe('SAVE_NOT_FOUND');
      expect(worker.saveCalls).toEqual([{ name: 'Shop', saveId: null }, 'save-1', 'save-9']);
    });

    it.each<[string, unknown]>([
      ['a blank name', request('saves.save', { request: { name: '   ', saveId: null } })],
      ['a long name', request('saves.save', { request: { name: 'x'.repeat(61), saveId: null } })],
      [
        'a control character',
        request('saves.save', { request: { name: 'a\u0007b', saveId: null } }),
      ],
      ['a path as save ID', request('saves.load', { saveId: '../../Windows/win.ini' })],
      ['an upper-case save ID', request('saves.load', { saveId: 'Save-1' })],
      [
        'a renderer-chosen export path',
        request('saves.export', { saveId: 'save-1', path: 'C:/x' }),
      ],
      ['a renderer-chosen import path', request('saves.import', { path: 'C:/x.fisave' })],
      ['a bad workspace key', request('workspace.set', { update: { key: '__proto__', value: 1 } })],
      [
        'an oversized workspace value',
        request('workspace.set', { update: { key: 'shell.notes', value: 'x'.repeat(20_000) } }),
      ],
    ])('refuses %s before reaching the worker', async (_name, raw) => {
      const { gateway, worker } = setup();
      expect(codeOf(await gateway.handle(trusted, raw))).toBe('MALFORMED_REQUEST');
      expect(worker.saveCalls).toEqual([]);
      expect(worker.exports).toEqual([]);
      expect(worker.imports).toEqual([]);
      expect(worker.workspaceUpdates).toEqual([]);
    });

    it('exports to the path chosen in main, which the renderer never sees', async () => {
      const { gateway, worker, dialogs } = setup();
      const result = await gateway.handle(trusted, request('saves.export', { saveId: 'save-1' }));
      expect(result).toEqual(ipcOk({ status: 'exported' }));
      expect(JSON.stringify(result)).not.toContain('Documents');
      expect(dialogs.suggested).toEqual(['Before lunch_ Shop_1.fisave']);
      expect(worker.exports).toEqual([
        { saveId: 'save-1', destinationPath: 'C:/Users/Player/Documents/Shop.fisave' },
      ]);
    });

    it('does nothing when the player cancels a dialog', async () => {
      const { gateway, worker, dialogs } = setup();
      dialogs.exportPath = null;
      dialogs.importPath = null;
      await expect(
        gateway.handle(trusted, request('saves.export', { saveId: 'save-1' })),
      ).resolves.toEqual(ipcOk({ status: 'cancelled' }));
      await expect(gateway.handle(trusted, request('saves.import'))).resolves.toEqual(
        ipcOk({ status: 'cancelled' }),
      );
      expect(worker.exports).toEqual([]);
      expect(worker.imports).toEqual([]);
    });

    it('imports from the path chosen in main', async () => {
      const { gateway, worker } = setup();
      await expect(gateway.handle(trusted, request('saves.import'))).resolves.toEqual(
        ipcOk({ status: 'imported', save: { ...SAVE, saveId: 'save-2' } }),
      );
      expect(worker.imports).toEqual(['C:/Users/Player/Downloads/Shop.fisave']);
    });

    it('refuses an export of a save that does not exist', async () => {
      const { gateway, worker, dialogs } = setup();
      expect(
        codeOf(await gateway.handle(trusted, request('saves.export', { saveId: 'save-9' }))),
      ).toBe('SAVE_NOT_FOUND');
      expect(dialogs.suggested).toEqual([]);
      expect(worker.exports).toEqual([]);
    });

    it('runs one save, load, export or import at a time', async () => {
      const { gateway, worker } = setup();
      let finish: (() => void) | undefined;
      worker.saveResult = () =>
        new Promise((resolve) => {
          finish = () => {
            resolve(ipcOk(SAVE));
          };
        });
      const first = gateway.handle(
        trusted,
        request('saves.save', { request: { name: 'A', saveId: null } }),
      );
      expect(
        codeOf(await gateway.handle(trusted, request('saves.load', { saveId: 'save-1' }))),
      ).toBe('BUSY');
      // Reading is not a persistence operation and is never blocked by one.
      expect(codeOf(await gateway.handle(trusted, request('saves.list')))).toBe('OK');
      finish?.();
      expect(codeOf(await first)).toBe('OK');
      expect(
        codeOf(await gateway.handle(trusted, request('saves.load', { saveId: 'save-1' }))),
      ).toBe('OK');
    });

    it('forwards workspace reads and updates', async () => {
      const { gateway, worker } = setup();
      await expect(gateway.handle(trusted, request('workspace.get'))).resolves.toEqual(
        ipcOk({ settings: {} }),
      );
      const update = { key: 'window.personnel', value: { x: 10, y: 20, open: true } };
      await expect(gateway.handle(trusted, request('workspace.set', { update }))).resolves.toEqual(
        ipcOk({ settings: { 'window.personnel': update.value } }),
      );
      expect(worker.workspaceUpdates).toEqual([update]);
    });
  });

  it.each<[string | null, string]>([
    ['Before lunch', 'Before lunch.fisave'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j.fisave'],
    ['trailing dots...', 'trailing dots.fisave'],
    ['CON', 'CON_.fisave'],
    ['...', 'FreeIndustry save.fisave'],
    [null, 'FreeIndustry save.fisave'],
  ])('suggests the export file name for %j as %j', (name, file) => {
    expect(exportFileName(name)).toBe(file);
  });
});

describe('IpcGateway: new worlds (Step 07)', () => {
  const newWorld = (world: unknown) => ({
    protocolVersion: 1,
    method: 'simulation.newWorld',
    world,
  });

  it('forwards a valid request and answers with a host snapshot', async () => {
    const { gateway, worker } = setup();
    const result = await gateway.handle(trusted, newWorld({ scenarioId: 'standard', seed: 42 }));
    expect(result).toEqual(ipcOk({ worker: worker.status, world }));
    expect(worker.newWorlds).toEqual([{ scenarioId: 'standard', seed: 42 }]);
    await gateway.handle(trusted, newWorld({ scenarioId: 'quick-start', seed: null }));
    expect(worker.newWorlds.at(-1)).toEqual({ scenarioId: 'quick-start', seed: null });
  });

  it.each([
    ['a missing seed', { scenarioId: 'standard' }],
    ['a seed beyond 32 bits', { scenarioId: 'standard', seed: 2 ** 32 }],
    ['a fractional seed', { scenarioId: 'standard', seed: 1.5 }],
    ['a negative seed', { scenarioId: 'standard', seed: -1 }],
    ['a path as scenario', { scenarioId: '../scenarios', seed: null }],
    ['an upper-case scenario', { scenarioId: 'Standard', seed: null }],
    ['an extra field', { scenarioId: 'standard', seed: null, capital: 1 }],
  ])('refuses %s before the worker', async (_name, world) => {
    const { gateway, worker } = setup();
    expect(codeOf(await gateway.handle(trusted, newWorld(world)))).toBe('MALFORMED_REQUEST');
    expect(worker.newWorlds).toEqual([]);
  });

  it('counts as a persistence operation: it may autosave the world it replaces', async () => {
    const { gateway, worker } = setup();
    let finish: (() => void) | undefined;
    worker.saveResult = () =>
      new Promise((resolve) => {
        finish = () => {
          resolve(ipcOk(SAVE));
        };
      });
    const saving = gateway.handle(trusted, {
      protocolVersion: 1,
      method: 'saves.save',
      request: { name: 'A', saveId: null },
    });
    expect(
      codeOf(await gateway.handle(trusted, newWorld({ scenarioId: 'standard', seed: null }))),
    ).toBe('BUSY');
    finish?.();
    await saving;
    expect(
      codeOf(await gateway.handle(trusted, newWorld({ scenarioId: 'standard', seed: null }))),
    ).toBe('OK');
  });
});
