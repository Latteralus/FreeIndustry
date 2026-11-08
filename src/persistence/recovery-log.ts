import { existsSync } from 'node:fs';
import { canonicalJson, type JsonValue } from '../shared/canonical-json';
import {
  bigCell,
  int64,
  intCell,
  openDatabase,
  textCell,
  withDatabase,
  type SqliteDatabase,
} from './database';
import { checkIntegrity } from './integrity';
import { applyMigrations, latestVersion, readSchemaStamp, SAVE_MIGRATIONS } from './migrations';
import { messageOf, SaveError } from './save-error';
import type { SaveImage, SaveLabel, WorkspaceSettings } from './save-image';
import { removeDatabaseFiles } from './save-store';
import { jsonCell, journalLength, readWorld, writeWorld } from './world-repository';

/**
 * The session recovery log (ADR-0028): crash durability between saves.
 *
 * A WAL-mode database in the save schema, kept open by the worker for the
 * world it is running. It holds a checkpoint of that world (snapshot plus
 * journal, written incrementally: only new journal entries are appended) and,
 * after the checkpoint, every accepted command in order, appended *before*
 * the command's receipt is sent. A clock mark records how far simulated time
 * has run. Replaying the commands on the checkpoint, then advancing to the
 * mark, rebuilds the world exactly, because the simulation is deterministic.
 *
 * A clean shutdown deletes the log. A log found when the worker starts means
 * the previous session ended abnormally; the worker rebuilds it into a
 * "Recovered" save and deletes it.
 */

export interface RecoveryCommand {
  /** Simulation time at which the command took effect. */
  readonly atMs: bigint;
  /** World revision after the command. */
  readonly revision: number;
  readonly commandId: string;
  readonly type: string;
  readonly payload: JsonValue;
}

export interface RecoveryContents {
  readonly image: SaveImage;
  readonly label: SaveLabel;
  readonly commands: readonly RecoveryCommand[];
  /** Furthest simulated time reached, if marked after the checkpoint. */
  readonly clockMs: bigint | null;
}

export class RecoveryLog {
  readonly path: string;
  readonly #db: SqliteDatabase;
  #closed = false;

  private constructor(path: string, db: SqliteDatabase) {
    this.path = path;
    this.#db = db;
  }

  /** Start a new log. Refuses to overwrite one left by an earlier session. */
  static create(path: string, context: { appVersion: string; now: () => Date }): RecoveryLog {
    if (existsSync(path)) {
      throw new Error('A recovery log from an earlier session still exists');
    }
    const db = openDatabase(path, { mode: 'create', journal: 'wal' });
    try {
      applyMigrations(db, SAVE_MIGRATIONS, {
        appVersion: context.appVersion,
        appliedAt: context.now().toISOString(),
      });
    } catch (error) {
      db.close();
      removeDatabaseFiles(path);
      throw error;
    }
    return new RecoveryLog(path, db);
  }

  /** Journal entries already stored; the next checkpoint appends from here + 1. */
  get journalLength(): number {
    return journalLength(this.#db);
  }

  /**
   * Replace the checkpoint. `image.journal` holds the entries from
   * `journalFromSeq` on; pass 1 and the whole journal for a different world.
   * Clears the commands and clock mark that the new checkpoint includes.
   */
  checkpoint(image: SaveImage, label: SaveLabel, journalFromSeq: number): void {
    this.#db
      .transaction(() => {
        writeWorld(this.#db, image, label, journalFromSeq);
        this.#db.prepare('DELETE FROM recovery_commands').run();
        this.#db.prepare('DELETE FROM recovery_clock').run();
      })
      .immediate();
  }

  appendCommand(command: RecoveryCommand): void {
    this.#db
      .prepare(
        'INSERT INTO recovery_commands (revision, at_ms, command_id, type, payload_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        command.revision,
        int64(command.atMs, 'Command time'),
        command.commandId,
        command.type,
        canonicalJson(command.payload),
      );
  }

  get commandCount(): number {
    const row = this.#db.prepare('SELECT count(*) AS n FROM recovery_commands').get() as {
      n: unknown;
    };
    return intCell(row.n, 'recovery command count');
  }

  markClock(nowMs: bigint): void {
    this.#db
      .prepare(
        'INSERT INTO recovery_clock (singleton, now_ms) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET now_ms = excluded.now_ms',
      )
      .run(int64(nowMs, 'Clock mark'));
  }

  writeWorkspace(settings: WorkspaceSettings): void {
    this.#db
      .transaction(() => {
        this.#db.prepare('DELETE FROM workspace_settings').run();
        const insert = this.#db.prepare(
          'INSERT INTO workspace_settings (key, value_json) VALUES (?, ?)',
        );
        for (const [key, value] of Object.entries(settings)) {
          insert.run(key, canonicalJson(value));
        }
      })
      .immediate();
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }

  /** Close and delete the log (clean shutdown, or the world it covered is safe elsewhere). */
  discard(): void {
    this.close();
    removeDatabaseFiles(this.path);
  }
}

/** Read a log left by an earlier session. Throws `SaveError` if it cannot be trusted. */
export function readRecoveryLog(path: string): RecoveryContents {
  try {
    return withDatabase(path, { mode: 'write', journal: 'wal' }, (db) => {
      const stamp = readSchemaStamp(db);
      if (stamp.userVersion !== latestVersion(SAVE_MIGRATIONS)) {
        throw new SaveError(
          'UNSUPPORTED_FORMAT',
          `The recovery log uses save format ${stamp.userVersion}, not this build's`,
        );
      }
      const problems = checkIntegrity(db, SAVE_MIGRATIONS, stamp.userVersion);
      if (problems.length > 0) {
        throw new SaveError('CORRUPT', `The recovery log is damaged: ${problems.join('; ')}`);
      }
      const { image, label } = readWorld(db);
      const commands = (
        db.prepare('SELECT * FROM recovery_commands ORDER BY revision').all() as Record<
          string,
          unknown
        >[]
      ).map((row): RecoveryCommand => ({
        atMs: bigCell(row['at_ms'], 'at_ms'),
        revision: intCell(row['revision'], 'revision'),
        commandId: textCell(row['command_id'], 'command_id'),
        type: textCell(row['type'], 'type'),
        payload: jsonCell(row['payload_json'], 'payload'),
      }));
      const clock = db.prepare('SELECT now_ms FROM recovery_clock').get() as
        { now_ms: unknown } | undefined;
      return {
        image,
        label,
        commands,
        clockMs: clock ? bigCell(clock.now_ms, 'now_ms') : null,
      };
    });
  } catch (error) {
    if (error instanceof SaveError) {
      throw error;
    }
    throw new SaveError('CORRUPT', `The recovery log could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
}
