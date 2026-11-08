import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError, FileLogger } from '../../../src/main/logger';

describe('FileLogger', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'freeindustry-log-test-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const now = () => new Date('2026-11-07T12:00:00.000Z');

  function lines(file = 'freeindustry.log'): unknown[] {
    return readFileSync(join(directory, file), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }

  it('writes one JSON object per line with time, level, source and fields', () => {
    const logger = new FileLogger({ directory, now });
    logger.log('info', 'started', { generation: 1 });
    logger.log('warn', 'from worker', {}, 'worker');
    expect(lines()).toEqual([
      {
        time: '2026-11-07T12:00:00.000Z',
        level: 'info',
        source: 'main',
        message: 'started',
        fields: { generation: 1 },
      },
      { time: '2026-11-07T12:00:00.000Z', level: 'warn', source: 'worker', message: 'from worker' },
    ]);
  });

  it('creates the log directory if needed', () => {
    const nested = join(directory, 'a', 'logs');
    new FileLogger({ directory: nested, now }).log('info', 'x');
    expect(readdirSync(nested)).toEqual(['freeindustry.log']);
  });

  it('rotates by size and keeps a bounded number of backups', () => {
    const logger = new FileLogger({ directory, now, maxBytes: 200, maxBackups: 2 });
    for (let index = 0; index < 20; index += 1) {
      logger.log('info', `entry ${index}`);
    }
    expect(readdirSync(directory).sort()).toEqual([
      'freeindustry.log',
      'freeindustry.log.1',
      'freeindustry.log.2',
    ]);
    // Newest entries are in the active file; nothing exceeds the size limit.
    const active = lines() as { message: string }[];
    expect(active.at(-1)?.message).toBe('entry 19');
    for (const file of readdirSync(directory)) {
      expect(readFileSync(join(directory, file)).length).toBeLessThanOrEqual(200);
    }
  });

  it('continues an existing file rather than truncating it', () => {
    new FileLogger({ directory, now }).log('info', 'first run');
    new FileLogger({ directory, now }).log('info', 'second run');
    expect((lines() as { message: string }[]).map((entry) => entry.message)).toEqual([
      'first run',
      'second run',
    ]);
  });

  it('describes thrown values as plain fields', () => {
    expect(describeError(new TypeError('bad'))).toMatchObject({
      errorName: 'TypeError',
      errorMessage: 'bad',
    });
    expect(describeError('text')).toEqual({ errorMessage: 'text' });
  });
});
