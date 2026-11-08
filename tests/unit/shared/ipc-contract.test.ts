import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/shared/canonical-json';
import { COMMANDS, isCommandType } from '../../../src/shared/ipc/commands';
import {
  commandEnvelopeSchema,
  ipcFail,
  rendererRequestSchema,
  workerStatusSchema,
} from '../../../src/shared/ipc/contract';
import { workerMessageSchema, workerRequestSchema } from '../../../src/shared/ipc/worker-protocol';

const valid = {
  commandId: '0b9f1c2e-7a4d-4e5f-9a6b-1c2d3e4f5a6b',
  worldInstanceId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
  expectedWorldRevision: 0,
  type: 'diagnostics.recordProbe',
  payload: { label: 'x' },
};

describe('command envelope schema', () => {
  it('accepts a well-formed envelope', () => {
    expect(commandEnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['extra fields', { ...valid, sql: 'DROP TABLE firms' }],
    ['a non-UUID command ID', { ...valid, commandId: '1' }],
    ['a negative revision', { ...valid, expectedWorldRevision: -1 }],
    ['a fractional revision', { ...valid, expectedWorldRevision: 0.5 }],
    ['an unsafe-integer revision', { ...valid, expectedWorldRevision: 2 ** 53 }],
    ['a string revision', { ...valid, expectedWorldRevision: '0' }],
    ['an empty type', { ...valid, type: '' }],
    ['an over-long type', { ...valid, type: 'x'.repeat(65) }],
  ])('rejects %s', (_name, value) => {
    expect(commandEnvelopeSchema.safeParse(value).success).toBe(false);
  });
});

describe('renderer request schema', () => {
  it('accepts exactly the three bridge methods', () => {
    for (const method of ['simulation.getSnapshot', 'simulation.restartWorker']) {
      expect(rendererRequestSchema.safeParse({ protocolVersion: 1, method }).success).toBe(true);
    }
    expect(
      rendererRequestSchema.safeParse({
        protocolVersion: 1,
        method: 'simulation.submitCommand',
        envelope: valid,
      }).success,
    ).toBe(true);
    expect(
      rendererRequestSchema.safeParse({ protocolVersion: 1, method: 'saves.delete' }).success,
    ).toBe(false);
    expect(
      rendererRequestSchema.safeParse({ protocolVersion: 2, method: 'simulation.getSnapshot' })
        .success,
    ).toBe(false);
  });
});

describe('command registry', () => {
  it('does not treat inherited object properties as commands', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isCommandType(name)).toBe(false);
    }
  });

  it('marks fault injection as a restricted permission', () => {
    expect(COMMANDS['diagnostics.injectFault'].permission).toBe('fault-injection');
    expect(COMMANDS['diagnostics.recordProbe'].permission).toBe('renderer');
  });
});

describe('worker protocol schemas', () => {
  it('rejects unknown kinds in both directions', () => {
    expect(workerRequestSchema.safeParse({ kind: 'eval', requestId: 1, code: '1' }).success).toBe(
      false,
    );
    expect(workerMessageSchema.safeParse({ kind: 'grantMoney', cents: '100' }).success).toBe(false);
  });

  it('requires positive integer request IDs', () => {
    expect(workerRequestSchema.safeParse({ kind: 'getSnapshot', requestId: 0 }).success).toBe(
      false,
    );
    expect(workerRequestSchema.safeParse({ kind: 'getSnapshot', requestId: 1 }).success).toBe(true);
  });

  it('validates worker status records', () => {
    expect(
      workerStatusSchema.safeParse({ state: 'ready', generation: 1, failure: null }).success,
    ).toBe(true);
    expect(
      workerStatusSchema.safeParse({ state: 'exploded', generation: 1, failure: null }).success,
    ).toBe(false);
  });
});

describe('ipcFail', () => {
  it('omits details when none are given', () => {
    expect(ipcFail('BUSY', 'later')).toEqual({
      ok: false,
      error: { code: 'BUSY', message: 'later' },
    });
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: null, e: 'x' }], c: true } })).toBe(
      '{"a":{"c":true,"d":[2,{"e":"x","f":null}]},"b":1}',
    );
  });

  it('property: equal data gives equal text regardless of key order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const shuffled = JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return Object.fromEntries(Object.entries(item).reverse());
          }
          return item;
        }) as unknown;
        expect(canonicalJson(shuffled)).toBe(canonicalJson(value));
      }),
    );
  });

  it.each([undefined, Number.NaN, Infinity, 1n, () => 1, new Date(0), new Map()])(
    'refuses non-JSON data %p rather than silently dropping it',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(TypeError);
    },
  );
});

describe('renderer content security policy', () => {
  const html = readFileSync(join(__dirname, '../../../src/renderer/index.html'), 'utf8');
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  const directives = new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map((parts) => [parts[0] ?? '', parts.slice(1)]),
  );

  it('allows only bundled scripts, with no eval or inline code', () => {
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('unsafe-inline');
  });

  it('forbids plugins, base-URI changes and form submission', () => {
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
  });

  it('allows network connections only to the app itself', () => {
    expect(directives.get('connect-src')).toEqual(["'self'"]);
  });
});
