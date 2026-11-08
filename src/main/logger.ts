import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogFields, LogLevel } from '../shared/ipc/worker-protocol';

/**
 * Structured local logs (spec §4.3, ADR-0015): one JSON object per line in
 * `<userData>/logs/freeindustry.log`, rotated by size to `.1` … `.N`.
 * Logs never leave the machine. Electron main is the only writer; the worker
 * forwards its entries as messages.
 */

export type LogSource = 'main' | 'worker';

interface LogEntry {
  readonly time: string;
  readonly level: LogLevel;
  readonly source: LogSource;
  readonly message: string;
  readonly fields?: LogFields;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields, source?: LogSource): void;
}

export interface FileLoggerOptions {
  readonly directory: string;
  readonly fileName?: string;
  /** Rotate before a write would make the file larger than this. */
  readonly maxBytes?: number;
  /** Rotated files kept besides the active one. */
  readonly maxBackups?: number;
  readonly now?: () => Date;
  /** Also write each line to stdout/stderr (development). */
  readonly mirrorToConsole?: boolean;
}

const LOG_FILE_NAME = 'freeindustry.log';

export class FileLogger implements Logger {
  readonly path: string;
  readonly #directory: string;
  readonly #fileName: string;
  readonly #maxBytes: number;
  readonly #maxBackups: number;
  readonly #now: () => Date;
  readonly #mirror: boolean;
  #size: number;

  constructor(options: FileLoggerOptions) {
    this.#directory = options.directory;
    this.#fileName = options.fileName ?? LOG_FILE_NAME;
    this.#maxBytes = options.maxBytes ?? 1024 * 1024;
    this.#maxBackups = options.maxBackups ?? 4;
    this.#now = options.now ?? (() => new Date());
    this.#mirror = options.mirrorToConsole ?? false;
    this.path = join(this.#directory, this.#fileName);
    mkdirSync(this.#directory, { recursive: true });
    this.#size = fileSize(this.path);
  }

  log(level: LogLevel, message: string, fields?: LogFields, source: LogSource = 'main'): void {
    const entry: LogEntry = {
      time: this.#now().toISOString(),
      level,
      source,
      message,
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
        this.#rotate();
      }
      appendFileSync(this.path, line, 'utf8');
      this.#size += bytes;
    } catch (error) {
      // Logging must never take the application down.
      console.error('FreeIndustry: could not write log entry', error);
    }
    if (this.#mirror) {
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
    }
  }

  #rotate(): void {
    const backup = (index: number) => join(this.#directory, `${this.#fileName}.${index}`);
    rmSync(backup(this.#maxBackups), { force: true });
    for (let index = this.#maxBackups - 1; index >= 1; index -= 1) {
      if (exists(backup(index))) {
        renameSync(backup(index), backup(index + 1));
      }
    }
    if (this.#maxBackups >= 1) {
      renameSync(this.path, backup(1));
    } else {
      rmSync(this.path, { force: true });
    }
    this.#size = 0;
  }
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = {
  log: () => undefined,
};

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Plain, loggable description of a thrown value. */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack ?? null };
  }
  return { errorMessage: String(error) };
}
