# FreeIndustry — Decision Record

Architecture and tooling decisions, newest last. Each entry states the choice,
why, the alternatives rejected, and whether it needs project-owner approval.
The requirements authority is [TechnicalDocument.md](TechnicalDocument.md); the
build order is [plan.md](plan.md).

Status values: **Accepted** (within the agent's remit under spec §15.2),
**Needs owner review** (touches naming, design laws, or something the owner
already decided), **Superseded**.

---

## ADR-0001 — Toolchain versions (bootstrap, upgraded the same day)

**Status:** Accepted · 2026-11-07 (revised by ADR-0011)

Spec §13.2 asks for current, mutually compatible, exact versions recorded here.
All are pinned exactly in `package.json` and locked in `package-lock.json`. As of this
entry, `npm outdated` lists only `@types/node` (deliberately on 24.x, see below) and
`typescript` (the TS 6 API package; TS 7 is installed alongside it, see ADR-0011).

| Tool                                                       | Version                   | Note                                                  |
| ---------------------------------------------------------- | ------------------------- | ----------------------------------------------------- |
| Node.js (dev host)                                         | 24.22.1 LTS               | `.nvmrc` `24`; `engines.node >= 24.22.0`              |
| npm                                                        | 12.2.2                    | `engines.npm >= 12.2.0`; enforces `allowScripts`      |
| Electron                                                   | 45.2.3                    | Bundles Node 24.22.2, Chromium 156.0.8078.80          |
| electron-vite / Vite                                       | 6.0.0 / 8.3.6             | Vite 8 uses Rolldown (`build.rolldownOptions`)        |
| @vitejs/plugin-react                                       | 6.2.1                     |                                                       |
| electron-builder / @electron/rebuild                       | 26.18.0 / 4.2.1           |                                                       |
| React / React DOM                                          | 19.3.1                    |                                                       |
| PixiJS                                                     | 8.22.0                    | Installed; first used in Step 09                      |
| better-sqlite3                                             | 13.0.3                    | Installed; first used in Step 04 (see ADR-0005)       |
| Zod                                                        | 4.6.7                     |                                                       |
| TypeScript, type-checking (`typescript-7`)                 | 7.0.2                     | Native compiler; `npm run typecheck` (ADR-0011)       |
| TypeScript, tool API (`typescript`)                        | 6.0.3                     | For typescript-eslint, ts-jest, the editor (ADR-0011) |
| @types/node                                                | 24.19.2                   | Newest 24.x; matches Electron's Node 24, not 26.x     |
| ESLint / @eslint/js                                        | 10.14.0 / 10.0.1          |                                                       |
| typescript-eslint                                          | 8.72.1                    |                                                       |
| eslint-plugin-import-x / eslint-import-resolver-typescript | 4.18.0 / 4.4.5            | Cycle detection                                       |
| eslint-plugin-react-hooks / eslint-plugin-jsx-a11y-x       | 7.1.1 / 0.2.0             | jsx-a11y-x is the maintained fork (ADR-0011)          |
| Prettier / eslint-config-prettier                          | 3.9.10 / 10.1.8           |                                                       |
| Jest / ts-jest / jest-environment-jsdom                    | 30.5.2 / 29.4.15 / 30.5.2 |                                                       |
| Testing Library (react / dom / jest-dom)                   | 16.3.3 / 10.4.2 / 7.0.1   |                                                       |
| fast-check                                                 | 4.10.2                    |                                                       |
| Playwright                                                 | 1.65.0                    | Drives Electron directly; no browser download needed  |
| Husky / lint-staged                                        | 9.1.7 / 17.6.0            |                                                       |
| knip / tsx / cross-env                                     | 6.44.2 / 4.23.15 / 10.1.0 |                                                       |
| GitHub Actions: checkout / setup-node / upload-artifact    | v7 / v7 / v7              | CI also installs npm 12.2.2 before `npm ci`           |

**Alternatives rejected:** `--force`/`--legacy-peer-deps` to take newest majors (breaks
reproducible clean installs); the caret ranges in the draft `package.json` (spec requires
exact pins); `@types/node` 26.x (would type APIs that Electron's Node 24 does not have).

**Audit:** `npm audit --omit=dev` → 0 vulnerabilities. `npm audit` reports 35
low/moderate advisories, all transitive in dev tooling, from three root causes:
`minimatch` 7 – 11.0.0 (ReDoS; fixed in 11.0.1), `glob` 9 – 14.0.1 (fixed in 14.0.2) and
`deepmerge` ≤ 4.3.1 (no fix published). They are reached through Jest, ESLint plugins,
electron-builder and typescript-eslint, and only ever process this repository's own
trusted globs. Forcing the fixed majors with `overrides` under tools that declare older
majors was rejected as fragile; revisit as upstream tools update.

## ADR-0002 — Module formats: ESM project, CommonJS preload, CommonJS under Jest

**Status:** Accepted · 2026-11-07

- `package.json` has `"type": "module"` (spec §13.3). Electron main is emitted as ESM
  (`out/main/index.js`) and uses `import.meta.dirname`.
- The preload is forced to CommonJS (`out/preload/index.cjs`) because Electron's
  **sandboxed** preload scripts cannot be ES modules, and the sandbox stays on (spec §4.3).
- Jest runs through `ts-jest` with `tsconfig.jest.json` emitting CommonJS (spec §13.4).
  Imports are written extension-less (`moduleResolution: bundler`), which TS 6 (the compiler ts-jest uses) allows
  together with `module: CommonJS`.

**Rejected:** native ESM Jest (experimental VM modules; spec asks for CommonJS test output);
an unsandboxed ESM preload (weakens isolation).

## ADR-0003 — TypeScript projects split along process boundaries

**Status:** Accepted · 2026-11-07

`tsconfig.base.json` holds the strict options from spec §13.4 (`strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, plus `noImplicitOverride`,
`noPropertyAccessFromIndexSignature`, `noUnused*`). `npm run typecheck` checks three
programs separately:

- `tsconfig.node.json` — main, preload, worker, domain, simulation, persistence, catalog,
  shared, scripts; Node types, **no DOM**.
- `tsconfig.web.json` — renderer + shared; DOM and Vite client types, **no Node types**.
- `tsconfig.test.json` — tests with Node, DOM and Jest types.

`tsconfig.json` is an umbrella for the editor and ESLint's project service only.

**Rejected:** a solution-style `tsconfig.json` with `composite` references (forces every
imported file to be listed in each project, which fights cross-layer `shared` imports).

## ADR-0004 — Enforcing module boundaries and determinism with ESLint

**Status:** Accepted · 2026-11-07

Spec §4.4 requires lint-enforced boundaries and no circular imports. Implemented in
`eslint.config.mjs`:

| Layer (`src/…`) | May import layers                                | Forbidden packages                                       |
| --------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `shared`        | —                                                | electron, react, pixi.js, better-sqlite3, Node built-ins |
| `domain`        | shared                                           | same as shared                                           |
| `simulation`    | domain, shared                                   | same as shared                                           |
| `catalog`       | domain, shared                                   | electron, react, pixi.js, better-sqlite3                 |
| `persistence`   | domain, catalog, shared                          | electron, react, pixi.js                                 |
| `worker`        | domain, simulation, persistence, catalog, shared | electron, react, pixi.js                                 |
| `main`          | shared                                           | react, pixi.js, better-sqlite3                           |
| `preload`       | shared                                           | react, pixi.js, better-sqlite3                           |
| `renderer`      | shared                                           | electron, better-sqlite3, Node built-ins                 |

- Packages and built-ins are matched by **exact specifier**, not glob: Node has built-ins
  named `domain`, `module` and `events` that a glob would confuse with our directories
  (found by a probe during Step 01).
- `import-x/no-cycle` (with the TypeScript resolver) rejects circular imports.
- In `domain`, `simulation`, `catalog` and `shared`, `Math.random`, `Date.now`,
  `performance.now` and argument-less `new Date()` are lint errors (spec §9.4, D09).
- All rules were verified with throwaway probe files that violated each one.

**Rejected:** `eslint-plugin-boundaries` (more configuration for the same effect at this size).

## ADR-0005 — better-sqlite3 13 uses Node-API prebuilds; one binary for Jest and Electron

**Status:** Accepted · 2026-11-07

better-sqlite3 13.0.3 ships ABI-stable Node-API prebuilds (`gypfile: false`). Verified on
the dev host: the same installed binary opens an in-memory database under Node 22.14 (Jest)
and under Electron 45 (`ELECTRON_RUN_AS_NODE`), both reporting SQLite 3.53.4. So unit and
integration tests can use real SQLite without a separate ABI rebuild, and no Visual Studio
build tools are needed to install. Re-verified after the Node 24.22.1 upgrade (ADR-0011),
where npm 12's `allowScripts` also denies the package's implicit `node-gyp rebuild`.

`postinstall: electron-builder install-app-deps` is kept as a safety net for any future
native dependency; `rebuild:native` remains for manual use. Packaging unpacks `**/*.node`
from the ASAR (verified in `release/win-unpacked/resources/app.asar.unpacked`). Step 04
still owns proving real SQLite reads and writes in the packaged app (spec §13.5).

## ADR-0006 — Document file names

**Status:** Accepted by project owner · 2026-11-07

The specification stays at `docs/TechnicalDocument.md` and the plan at `docs/plan.md`.
`plan.md` originally referred to `docs/TECHNICAL_SPECIFICATION.md` and a root `plan.md`;
on the owner's instruction those references were updated to the current names.

## ADR-0007 — LF line endings everywhere; Prettier formats Markdown, including the spec

**Status:** Accepted · 2026-11-07

`.gitattributes` now says `* text=auto eol=lf`. With the previous `* text=auto` and this
host's `core.autocrlf=true`, a clean Windows checkout would produce CRLF files and fail
`format:check` (Prettier `endOfLine: lf`). Prettier also formats Markdown; on first run
it reformatted `docs/TechnicalDocument.md` and `docs/plan.md` cosmetically only (table
column alignment, blank lines after headings, `*emphasis*` → `_emphasis_`). No wording
changed.

## ADR-0008 — Content Security Policy baseline

**Status:** Accepted · 2026-11-07

`src/renderer/index.html` carries a meta CSP: `default-src 'self'; script-src 'self';
style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'`. The built app logs no CSP
violations.

- `frame-ancestors` was removed: browsers ignore it when it is delivered by `<meta>`, and
  Chromium logs an error. Step 02 may add a header-delivered CSP via the session.
- The Vite dev server injects CSS as inline `<style>` elements, so a dev-only plugin
  (`apply: 'serve'`) adds `'unsafe-inline'` to `style-src`. Built output is unaffected.

## ADR-0009 — Packaging configuration lives in `electron-builder.yml`

**Status:** Accepted · 2026-11-07

The draft `package.json` `build` block moved to `electron-builder.yml` (spec §13.1 calls it
authoritative). `buildResources` is `resources/`, because `.gitignore` already ignores
`build/` (electron-builder's default resources directory). There is no application icon
yet, so the default Electron icon is used (Step 36).

## ADR-0010 — Items deliberately deferred from Step 01

**Status:** Accepted · 2026-11-07

- `check:content` (spec §13.3) is **not** defined yet. No content schema exists until the
  catalog work; a validator that validates nothing would be a façade.
- `electron-log` (optional, spec §13.2) is not installed; structured local logs are
  Step 02 work.
- `cross-env` is installed because spec §13.2 lists it but no script needs it yet; knip
  is told to ignore it, along with `pixi.js` and `better-sqlite3`, which are planned but
  not yet imported.
- Docs listed in spec §13.1 but not required by Step 01 (`GAMEPLAY_RULES.md`,
  `DATA_MODEL.md`, `TESTING.md`) are not created yet; `TEST_SCENARIOS.md` (from plan.md)
  covers testing for now.

## ADR-0011 — Toolchain upgrade: TypeScript 7, ESLint 10, Node 24, npm 12

**Status:** Accepted (owner asked for the newest compatible versions) · 2026-11-07

**TypeScript 7 alongside TypeScript 6.** The `typescript@7` npm package is the native
compiler and no longer contains the JavaScript compiler API (its main export is only a
version file). `typescript-eslint` 8.72 (including its canary build) needs
`typescript <6.1.0` and `ts-jest` 29.4 needs `<7`, and both `require('typescript')`.

- `typescript` = 6.0.3: the API used by typescript-eslint, ts-jest and the editor.
  `node_modules/.bin/tsc` is therefore TS 6.
- `typescript-7` = `npm:typescript@7.0.2`: run via `npm run tsc7` (which calls
  `node node_modules/typescript-7/bin/tsc`). `npm run typecheck` uses it for the three
  boundary programs. Probed: TS 7 reports ordinary type errors and
  `noUncheckedIndexedAccess` violations.
- `@typescript/typescript6` (Microsoft's side-by-side package, bin `tsc6`) was tried and
  removed: it is only a wrapper that depends on `typescript@6`, whose hoisted copy took
  over the `tsc` link from TS 7, so it added nothing.
- Removed from `tsconfig.base.json`: `esModuleInterop` (always on since TS 6) and
  `forceConsistentCasingInFileNames` (default true).
- Revisit when typescript-eslint and ts-jest support TS 7: make `typescript` 7 and drop
  the alias.

**ESLint 10 with `eslint-plugin-jsx-a11y-x`.** The original `eslint-plugin-jsx-a11y`
(last published October 2024) declares peer `eslint <= 9`. `eslint-plugin-jsx-a11y-x`
0.2.0 is the maintained fork (es-tooling, published May 2026) with peer
`eslint ^9 || ^10` and the same rules under the `jsx-a11y-x/` prefix, which satisfies the
spec's accessibility-lint requirement (§13.4). The config now uses ESLint's own
`defineConfig` instead of the deprecated `tseslint.config()`. Probed under ESLint 10:
`alt-text`, `click-events-have-key-events`, `no-static-element-interactions`,
`rules-of-hooks`, `no-cycle`, boundary imports, `Math.random` and `Date.now` all report.
A duplicate report for `node:`-prefixed built-ins was removed from the boundary rule.

**Node 24 LTS and npm 12.** lint-staged 17 needs Node >= 22.22.1. On the owner's choice,
the machine-wide Node was upgraded from 22.14.0 to 24.22.1 LTS with winget
(`OpenJS.NodeJS.LTS`), the newest winget build in Electron 45's Node 24.22 line, so tests
run on the same Node as the app. The user-level global npm was upgraded from 11.3.0 to
12.2.2. Both are machine-wide and affect other projects on this PC.

**npm 12 install-script policy.** npm 12 blocks dependency install scripts unless
`package.json` `allowScripts` allows them. Reviewed and recorded:

| Package               | Script                          | Decision | Reason                                                                 |
| --------------------- | ------------------------------- | -------- | ---------------------------------------------------------------------- |
| `esbuild@0.28.2`      | `postinstall: node install.js`  | Allow    | Verifies its platform binary (used by tsx)                             |
| `better-sqlite3`      | implicit `node-gyp rebuild`     | Deny     | Node-API prebuilds are used at runtime; denying avoids a C++ toolchain |
| `@parcel/watcher`     | `install: build-from-source.js` | Deny     | Fallback build only; prebuilt platform packages are used               |
| `electron-winstaller` | `install: select-7z-arch.js`    | Deny     | Squirrel installers only; we build NSIS                                |

The project's own `postinstall` (`electron-builder install-app-deps`) and `prepare`
(`husky`) still run.
