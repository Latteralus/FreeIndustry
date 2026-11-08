import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRecoveryLog, RecoveryLog } from '../../../src/persistence/recovery-log';
import { MS_PER_MINUTE } from '../../../src/domain/time';
import { command, imageOf, label, newWorld, tempDir, type TempDir } from '../../support/save-world';

let dir: TempDir;
let path: string;
const context = { appVersion: '0.1.0', now: () => new Date('2026-11-07T12:00:00.000Z') };

beforeEach(() => {
  dir = tempDir();
  path = join(dir.path, 'session.fisave');
});

afterEach(() => {
  dir.remove();
});

describe('RecoveryLog', () => {
  it('holds a checkpoint plus the commands and clock mark that followed it', () => {
    const world = newWorld();
    const log = RecoveryLog.create(path, context);
    log.checkpoint(imageOf(world), label('Session', 'recovered'), 1);
    command(world, 'diagnostics.recordProbe', { label: 'one' });
    const record = world.journal.entries.find((entry) => entry.kind === 'command');
    if (record?.kind !== 'command') {
      throw new Error('no command journaled');
    }
    log.appendCommand({
      atMs: record.atMs,
      revision: record.revision,
      commandId: record.commandId,
      type: record.type,
      payload: record.payload,
    });
    log.markClock(5n * MS_PER_MINUTE);
    log.markClock(9n * MS_PER_MINUTE);
    log.writeWorkspace({ 'shell.theme': 'classic' });
    expect(log.commandCount).toBe(1);
    log.close();
    const contents = readRecoveryLog(path);
    expect(contents.commands).toEqual([
      {
        atMs: 0n,
        revision: 1,
        commandId: record.commandId,
        type: 'diagnostics.recordProbe',
        payload: { label: 'one' },
      },
    ]);
    expect(contents.clockMs).toBe(9n * MS_PER_MINUTE);
    expect(contents.image.workspace).toEqual({ 'shell.theme': 'classic' });
    expect(contents.image.kernel.worldRevision).toBe(0);
  });

  it('appends the journal incrementally and clears what a new checkpoint includes', () => {
    const world = newWorld();
    const log = RecoveryLog.create(path, context);
    log.checkpoint(imageOf(world), label('Session', 'recovered'), 1);
    command(world, 'diagnostics.scheduleProbe', { label: 'a', delayMs: 60_000 });
    log.appendCommand({ atMs: 0n, revision: 1, commandId: 'c1', type: 'x', payload: null });
    world.advanceTo(2n * MS_PER_MINUTE);
    log.markClock(2n * MS_PER_MINUTE);
    const stored = log.journalLength;
    log.checkpoint(imageOf(world, stored + 1), label('Session', 'recovered'), stored + 1);
    expect(log.journalLength).toBe(world.journal.length);
    expect(log.commandCount).toBe(0);
    log.close();
    const contents = readRecoveryLog(path);
    expect(contents.image).toEqual(imageOf(world));
    expect(contents.commands).toEqual([]);
    expect(contents.clockMs).toBeNull();
  });

  it('never overwrites a log an earlier session left behind', () => {
    RecoveryLog.create(path, context).close();
    expect(() => RecoveryLog.create(path, context)).toThrow(/still exists/);
  });

  it('deletes itself and its WAL on a clean discard', () => {
    const log = RecoveryLog.create(path, context);
    log.checkpoint(imageOf(newWorld()), label('Session', 'recovered'), 1);
    log.discard();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir.path)).toEqual([]);
  });

  it('refuses to read a damaged log', () => {
    const log = RecoveryLog.create(path, context);
    log.close(); // a log with a schema but no world
    expect(() => readRecoveryLog(path)).toThrow(/damaged/);
  });
});
