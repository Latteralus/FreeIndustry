import { runInNewContext } from 'node:vm';
import { messageOf, sqliteCodeOf } from '../../../src/persistence/save-error';

describe('reading SQLite errors', () => {
  // Regression: better-sqlite3 creates its SqliteError class once per process, in the
  // realm that first loaded the addon. Under Jest, later test files run in another
  // realm where `instanceof Error` is false, and "not a database" was misreported.
  it('recognises an error from another JavaScript realm by its shape', () => {
    const foreign: unknown = runInNewContext(
      'Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" })',
    );
    expect(foreign instanceof Error).toBe(false);
    expect(sqliteCodeOf(foreign)).toBe('SQLITE_NOTADB');
    expect(messageOf(foreign)).toBe('file is not a database');
  });

  it('ignores codes that are not SQLite result codes', () => {
    expect(sqliteCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeNull();
    expect(sqliteCodeOf('SQLITE_NOTADB')).toBeNull();
    expect(messageOf('plain text')).toBe('plain text');
  });
});
