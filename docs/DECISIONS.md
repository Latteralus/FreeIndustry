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

## ADR-0012 — Simulation worker is a Node `worker_threads` thread in Electron main

**Status:** Accepted · 2026-11-07 (Step 02)

Spec §4.2 places the simulation in an isolated worker thread that owns world state and
the single SQLite writer. `src/worker/index.ts` is built as a second entry of the main
build (`out/main/worker.js`, ESM) and started by `WorkerSupervisor` with
`new Worker(…, { workerData })`. It imports no Electron and talks to main only through
the validated message protocol in `src/shared/ipc/worker-protocol.ts`.

- Verified to load from inside `app.asar` in the packaged `FreeIndustry.exe`; no
  `asarUnpack` entry is needed for the worker script.
- A JavaScript exception or `process.exit` in the worker ends only the thread; main sees
  `error`/`exit` and stays up (ADR-0014).

**Trade-off accepted:** a _native_ crash inside the worker (for example a fault in the
SQLite addon) would take down the whole app process, because threads share it. Electron's
`utilityProcess` would isolate that, at the cost of a second process, a different
messaging API and departing from the topology the spec describes. Revisit in Step 04 if
native crashes prove to be a practical risk. _Revisited in ADR-0029: none observed; kept._

**Rejected:** running the simulation in main (blocks the UI and the IPC broker);
`utilityProcess` now (see above); a hidden renderer window (would bring Chromium into the
authoritative side).

## ADR-0013 — IPC protocol v1: one validated request channel, revisions, idempotent commands

**Status:** Accepted · 2026-11-07 (Step 02)

**Surface.** The preload exposes `window.freeIndustry` = `{ protocolVersion, runtime,
simulation }`, all frozen. `simulation` has exactly `getSnapshot`, `submitCommand`,
`restartWorker` and `subscribe` (spec §11.2; saves arrive in Step 04). Each call becomes
`ipcRenderer.invoke('freeindustry:request', { protocolVersion: 1, method, … })`; host
events arrive on `freeindustry:event`. The renderer never sees `ipcRenderer`, channel
names, the `IpcRendererEvent`, file paths or database handles.

**Validation in main** (`src/main/ipc-gateway.ts`), in order: the sender is the top-level
frame of the app's own window at the bundled `index.html` (or the dev-server origin in
unpackaged dev) → protocol version → strict Zod request shape → in-flight limit (32, else
`BUSY`) → command type known, permission held, payload valid. **The worker validates the
envelope, type, permission and payload again** (`src/worker/command-host.ts`), so a
mistake in main cannot bypass the authority.

**Command envelope.** `{ commandId (UUID), worldInstanceId (UUID), expectedWorldRevision
(safe integer ≥ 0), type, payload }`.

- `worldInstanceId` is new every time a worker starts and every time a save is loaded, so a
  command prepared for one world cannot apply to another that happens to share a revision
  number.
- `worldRevision` = number of accepted commands. Each accepted command advances it by
  exactly one; a mismatch is `STALE_REVISION` with the current values in `details`.
  Rebasing is the client's job (fetch a snapshot, rebuild the command).
- **Idempotency:** the worker remembers accepted command IDs per world instance, with a
  canonical-JSON fingerprint (`src/shared/canonical-json.ts`) of their contents.
  Resubmitting the same ID and contents returns the stored receipt with `duplicate: true`
  and re-applies nothing; the same ID with different contents is `COMMAND_ID_REUSED`.
  Rejected commands are not remembered (they changed nothing). The map lives as long as the
  world instance; Step 03/04 move it into the persisted command journal.
- **Atomicity:** handlers return a new state; the host commits only after the handler
  returns. A thrown handler error is `INTERNAL_ERROR` with state unchanged.

**Errors** are values, never exceptions across IPC: `{ ok: false, error: { code, message,
details? } }` with codes `MALFORMED_REQUEST`, `UNSUPPORTED_PROTOCOL`, `UNAUTHORIZED`,
`UNKNOWN_COMMAND`, `INVALID_PAYLOAD`, `STALE_REVISION`, `COMMAND_ID_REUSED`,
`COMMAND_REJECTED` (reserved for business rules from Step 03), `BUSY`,
`WORKER_UNAVAILABLE`, `WORKER_TIMEOUT`, `INVALID_STATE`, `INTERNAL_ERROR`.

**Timeouts.** A worker request unanswered after 10 s resolves `WORKER_TIMEOUT` ("outcome
unknown"); resubmitting the same command ID is safe because of idempotency. A late answer
is logged and dropped.

**Snapshots, not deltas, for now.** Every host event makes the renderer fetch a full
snapshot, which stays correct even after a missed event. Versioned deltas with bounded
buffers (spec §11.2) wait until world state is large enough to need them (Step 03/09).

**Rejected:** one IPC channel per method (more surface to secure for no gain); a generic
`invoke(channel, …)` in the bridge (lets the renderer choose channels); validating in the
preload (it would bundle Zod into the sandbox and still not be authoritative); LRU-bounded
dedupe (an evicted ID could execute twice).

## ADR-0014 — Worker failure is explicit and recoverable; no automatic restart

**Status:** Accepted · 2026-11-07 (Step 02)

Spec §4.3: "Worker crashes trigger a safe pause and recoverable diagnostic, not silent
resets." When the worker emits `error` or exits unexpectedly, `WorkerSupervisor`:

1. logs the cause at `error`, with the number of pending requests;
2. resolves every unanswered request with `WORKER_UNAVAILABLE` ("not confirmed; unsaved
   worker state was lost") and logs each lost request;
3. sets status `failed` with the message and a wall-clock timestamp and pushes it to the
   renderer, which shows an alert with a **Restart worker** button;
4. refuses further commands until the player restarts.

Restart creates a new generation with a new world instance at revision 0, which the UI and
log state plainly. Messages and exits from an old generation are ignored. Since Step 04 the
new worker also rebuilds the dead one's recovery log into a "Recovered session" save the
player can load (ADR-0028).

Graceful stop (`before-quit`): status `stopping`, a `shutdown` request (the worker autosaves a
changed world and deletes its recovery log, ADR-0028), wait up to 30 s (5 s before Step 04)
for the thread to exit, otherwise `terminate()`. The quit is held until this finishes.

**Rejected:** automatic restart (a silent reset by another name, and a crash-loop risk).

## ADR-0015 — Structured logs: own JSON-lines writer in main, no `electron-log`

**Status:** Accepted · 2026-11-07 (Step 02)

`src/main/logger.ts` appends one JSON object per line (`time`, `level`, `source`,
`message`, `fields`) to `<userData>/logs/freeindustry.log`, rotating by size (1 MiB, four
backups `.1`–`.4`). Main is the only writer; the worker sends `log` messages. Logs are
never uploaded. Write failures go to stderr and never crash the app. About 100 lines, unit
tested, no new dependency; `electron-log` (optional in spec §13.2) is not needed.

Logs record command IDs, types, rejection codes, worker lifecycle and failures. They do not
record payload contents, so future player data does not leak into diagnostics.

## ADR-0016 — Step 02 diagnostic commands and development/test overrides

**Status:** Accepted · 2026-11-07 (Step 02)

There is no simulation kernel until Step 03, but the gate needs a real state-changing round
trip. The command registry (`src/shared/ipc/commands.ts`) therefore holds only:

- `diagnostics.recordProbe { label }`, permission `renderer`. Increments a probe counter in
  the worker. Shown in the development shell under "IPC diagnostics (development only)". It
  is not a game feature and will be removed or hidden once real commands exist.
- `diagnostics.injectFault { fault: handler-exception | uncaught-exception | thread-exit }`,
  permission `fault-injection`, used by automated failure tests.

**Overrides, honoured only when `app.isPackaged` is false:**

| Variable                         | Effect                                                         |
| -------------------------------- | -------------------------------------------------------------- |
| `FREEINDUSTRY_FAULT_INJECTION=1` | Grants the `fault-injection` permission (main and worker both) |
| `FREEINDUSTRY_USER_DATA_DIR`     | Uses that directory as `userData` (E2E isolation)              |
| `FREEINDUSTRY_WORLD_SEED=<n>`    | Fixed seed for new worlds, 0 – 4294967295 (Step 03, ADR-0021)  |

Verified in the packaged app: with `FREEINDUSTRY_FAULT_INJECTION=1` set,
`diagnostics.injectFault` is still `UNAUTHORIZED`.

## ADR-0017 — Additional Electron hardening; CSP stays in `<meta>`

**Status:** Accepted · 2026-11-07 (Step 02)

Added to the Step 01 baseline (in `src/main/window-security.ts`, unit tested):

- Every permission request and permission check is denied.
- `will-navigate` and `will-redirect` are refused except within the dev-server origin;
  `<webview>` attachment is refused; `window.open` is denied, and only `https:` URLs may be
  handed to the user's browser.
- IPC sender validation (ADR-0013).

The CSP remains the `<meta>` tag from ADR-0008. The app loads from `file://`, which has no
response headers to set, so a header-delivered CSP needs the renderer served from a custom
`app://` protocol. That is the Electron checklist's recommendation, but it changes how every
asset resolves and fits better with packaging hardening and Electron fuses (Step 36). E2E
confirms the meta CSP is enforced (inline script raises a `script-src-elem` violation).
`eval` cannot be probed from Playwright, because DevTools-evaluated code is exempt from
CSP; the policy text is asserted to omit `'unsafe-eval'` instead.

## ADR-0018 — Ledger file name restored to `original-reference-ledger.md`

**Status:** Needs owner review · 2026-11-07

The `init` commit added the ledger as `docs/original_reference_ledger.md`, but the
specification (§2.1, §13.1), `plan.md`, `CLAUDE.md` and `README.md` all link
`docs/original-reference-ledger.md`. The file was renamed back with `git mv`; its content is
unchanged. If the underscore name was intended, revert the rename and update those
references instead.

## ADR-0019 — A generic deterministic kernel with pluggable rules

**Status:** Accepted · 2026-11-07 (Step 03)

`src/simulation/kernel.ts` (`SimulationKernel<S>`) owns everything that must be identical on
every run: the clock, event ordering, the seeded random streams, entity IDs, the
command/event journal, revision and idempotency checks, atomicity and fingerprints. It knows
nothing about companies or machines. A `SimulationRules<S>` value (`src/simulation/rules.ts`)
supplies the domain state, its JSON encoding, its invariants, and its command, event and
periodic handlers. Production uses `FREEINDUSTRY_RULES` (`src/simulation/freeindustry-rules.ts`);
tests also use a fixture world (`tests/support/toy-workshop.ts`).

- **Pure business rules live in `src/domain`** (`time.ts`, `ids.ts`, `rejection.ts`,
  `diagnostics.ts`); the kernel, RNG, hashing, journal and scenario runner live in
  `src/simulation`. Neither imports Electron, React, PixiJS, SQLite or Node built-ins
  (lint-enforced, ADR-0004), and the kernel test asserts that Electron and PixiJS are not
  loaded.
- **Staged, all-or-nothing handlers.** A handler receives the current state and a
  `KernelContext` (`random`, `allocateId`, `schedule`, `record`, `calendar`) and returns a new
  state (or a `Rejection` for commands). Random draws, new IDs, scheduled events and recorded
  facts are staged and committed together with the returned state, or all discarded if the
  handler throws or rejects. Domain state is updated immutably.
- **Commands.** The kernel validates the payload against the command's schema, answers a
  resubmitted command ID from the journal (`duplicate: true`) or refuses a reused one
  (`COMMAND_ID_REUSED`), checks the expected revision (`STALE_REVISION`), runs the handler
  (`COMMAND_REJECTED` for a business-rule refusal, `INTERNAL_ERROR` for an exception) and
  journals the accepted command with its simulation time. World revision still means "number
  of accepted commands" (ADR-0013); time passing and events do not change it.
- **Event faults stop the world.** If an event handler throws, nothing it staged is committed,
  the event stays queued, and the kernel refuses further advances and commands
  (`INVALID_STATE`) with the fault recorded. The pacer pauses and the UI shows it (spec §4.3:
  a safe pause and a recoverable diagnostic, never a silent skip). An event that keeps
  rescheduling itself at one instant (more than 100 000 events) is treated the same way.
- **ADR-0013 amended.** The worker's `CommandHost` is now an adapter: it checks envelope, type,
  permission and world instance, then hands the command to the kernel. So the world-instance
  check now precedes the payload check, the idempotency map is the journal, and the receipt
  gains `atMs` (the simulation time the command took effect).

**Rejected:** one class per subsystem calling each other directly (ordering would depend on
call graphs, not on the queue); copying the whole world per command for rollback (does not
scale); undo logs (easy to get subtly wrong; staging is simpler to prove).

## ADR-0020 — Simulated time, calendar and event ordering

**Status:** Accepted · 2026-11-07 (Step 03)

- **Time** is a `bigint` count of simulated milliseconds since the world epoch (spec §9.3),
  which is midnight at the start of a calendar date. The calendar is the proleptic Gregorian
  calendar computed with integer arithmetic (Hinnant's algorithms) for years 1–9999, with no
  time zones or daylight saving. Day boundaries are multiples of 24 h; weeks are ISO weeks
  (Monday–Sunday). A test compares 2 000 random dates against JavaScript's `Date` as an
  independent oracle.
- **Ordering** is `(time, lane priority, sequence)` (spec §9.1). `sequence` is unique and
  increases in scheduling order, so the order is total and heap-layout independent; event IDs
  are `ev:<sequence>`.
- **Lanes** separate high-frequency physical work from lower-frequency decisions (plan
  Step 03): `physical` 100, `economic` 200, `management` 300, `accounting` 400, `diagnostic` 900. At one instant the physical outcome is settled before economic, management and
  accounting decisions look at it.
- **Periodic decision cycles** (`PeriodicDefinition`: lane, period, phase) fire at
  `phase + k × period` on a grid anchored to the epoch, so neither when nor how the world is advanced
  can move them. Physical work is scheduled at the exact times it completes; there
  is no global tick and no midnight batch.
- **The invariant** is that every event at or before `nowMs` has been processed. Two rules keep
  it: world creation processes everything due at time 0, and an event a command schedules for
  "now" runs immediately after that command. So a command at time `t` always follows every
  event at `t`, live or in replay. Both rules were added after tests exposed the ordering
  hazard they prevent.
- **`advanceTo(target, { maxEvents, stopAfterNotable })`** processes due events in order and
  then sets the clock to the target. An event budget, and a "notable event" stop, are honoured
  only at instant boundaries, so a command can never land between two events of the same
  instant. Splitting an advance into any number of pieces gives the same result as doing it at
  once (property-tested).
- Scheduling into the past and moving the clock backwards throw.

**Rejected:** `number` milliseconds (spec specifies `bigint`); a fixed-step tick loop (ties
outcomes to tick size and wastes work when nothing happens); `Date`/`Intl` calendar (time-zone
and host dependent, banned by lint in pure layers).

## ADR-0021 — Seeded random streams: xoshiro128\*\* with SplitMix32 seeding

**Status:** Accepted · 2026-11-07 (Step 03)

- Algorithm `xoshiro128**` (128-bit state, period 2¹²⁸ − 1), recorded as
  `xoshiro128**/splitmix32/v1` in every fingerprint and checkpoint. A test checks it against a
  separately written BigInt reference implementation for random states, and locks the exact
  output for one seed so an accidental change cannot silently alter saved worlds.
- **Named streams.** Each subsystem draws from its own stream (`diagnostics` now; later
  `labour-market`, `suppliers`, …). A stream's starting state is four SplitMix32 outputs from
  the world seed mixed with an FNV-1a hash of the name, created on first use and persisted. More
  draws in one subsystem never shift the numbers another subsystem sees.
- **Integers only:** `nextUint32`, `nextBelow` (rejection sampling, unbiased),
  `nextIntInclusive`, `chance(numerator, denominator)`, `pick`, `shuffled`. No floating-point
  results are offered to simulation code.
- **The seed** is an unsigned 32-bit integer chosen when a world is created (in the worker,
  with `crypto.randomInt`) and kept with it. Unpackaged builds accept
  `FREEINDUSTRY_WORLD_SEED` for reproducible tests; packaged builds ignore it, like the other
  overrides in ADR-0016. From Step 07 the New Company dialog will offer a seed.

**Rejected:** `Math.random` (banned, unseeded); Mersenne Twister (2.5 KB of state per stream);
PCG32 (needs 64-bit multiplies, i.e. BigInt, in JavaScript); one shared stream (any new draw
reshuffles everything after it).

## ADR-0022 — Fingerprints, journal and checkpoint format

**Status:** Accepted · 2026-11-07 (Step 03)

- **State hash:** SHA-256 of the canonical JSON (sorted keys, ADR-0013) of the complete world
  state: kernel format, rules ID and version, RNG algorithm, seed and epoch, clock, revision,
  processed-event count, next sequence, ID counters, RNG stream states, every pending event,
  and the domain state from the rules' `encodeState`. `bigint` values are canonical decimal
  strings (`bigint-codec`).
- **Journal hash:** a SHA-256 chain over every journal entry (each accepted command with its
  simulation time and revision, and each processed event, both with the facts their handlers
  recorded). It is extended incrementally when asked for.
- **Excluded from both:** the world-instance ID (a per-session identity, ADR-0013), clock speed,
  pause and advance state (ADR-0023) and anything wall-clock. These do not change outcomes, so
  they must not change fingerprints.
- **SHA-256 is written in plain TypeScript** (`src/simulation/sha256.ts`) because pure layers
  may not import Node's `crypto`. FIPS 180-4 vectors and Node's own implementation are used as
  test oracles. It identifies states; it is not a security control.
- **Checkpoints** are the same encoding plus the journal, so a fingerprint covers exactly what
  a restore needs. `SimulationKernel.restore` re-validates everything (schema, rules
  ID/version, RNG algorithm, sequences, lane priorities, command fingerprints, journal
  continuity, kernel and domain invariants) and refuses rather than repairs. A property test
  restores at random moments, through JSON text, and gets the uninterrupted run's fingerprints.
  This is the in-memory precursor of Step 04's SQLite persistence (which must not store core
  state only as a JSON blob, spec §10.2).
- **The journal is held in memory** while the world runs; saves store it in SQLite
  (ADR-0026). Each snapshot recomputes the state hash only when the state has changed. Step 33 measures both costs under load and may
  change the hash algorithm, which would be a new, versioned fingerprint format.

## ADR-0023 — Clock control is pacing, not a world command; provisional speeds

**Status:** Accepted · 2026-11-07 (Step 03); speed values provisional

- **Separate request.** Pause, speed and targeted advances go through a new bridge method
  `simulation.control(control)`, validated in main (strict Zod union) and forwarded as a
  `control` worker request answered with a world snapshot. They have no command ID or
  revision, are not journaled, and are excluded from fingerprints. This is what makes
  "different pause/speed patterns yield identical domain outcomes" true by construction. They
  are logged.
- **Pacer** (`src/worker/pacer.ts`), driven by a 50 ms wall-clock interval in the worker,
  independent of the renderer and its frame rate. Paused: zero simulation-time transitions.
  Running: advance by elapsed wall time × rate, with the fraction carried; at most 250 ms of
  wall time is converted per tick after a stall; each tick spends at most 25 ms simulating, in
  calls of 2 000 events, and if it cannot keep up, simulated time lags instead of building up
  debt.
- **Targeted advances** (spec §9.1) run as fast as that budget allows across ticks, then pause:
  Single Step = one simulated minute; End of Day = next midnight; End of Week = next Monday
  00:00; Next Event = until an instant containing a _notable_ event (event definitions mark
  themselves notable), giving up after 30 simulated days. Choosing any speed, including Pause,
  interrupts an advance. The last stop and its reason (`reached`, `notable`, `horizon`,
  `interrupted`, `fault`) are shown.
- **Speeds** (simulated ms per wall ms): Normal 20×, Faster 100×, Fastest 600×. These are
  FreeIndustry choices, not original values (ledger OR-13), and will be revisited when workers
  move visibly (Step 12) and in Options (Step 31).
- **Renderer updates:** the worker posts a `worldClock` notification at most every 200 ms
  while time runs, and immediately when an advance ends. Main forwards it as a `world.clock`
  host event. The renderer, as before, refetches a full snapshot on any host event (ADR-0013).
- **Commands while running** take effect at the simulation time the worker processes them,
  which is recorded in the journal. Replaying the journal therefore reproduces a live session
  exactly, whatever the wall-clock timing was.

**Rejected:** making speed a world command (it would enter the journal and fingerprints, so two
players with different pause habits would get "different" worlds); driving time from the
renderer's animation frame (couples outcomes to frame rate and window visibility); catching up
unboundedly after a stall (freezes the worker).

## ADR-0024 — Step 03 diagnostics and world defaults

**Status:** Accepted · 2026-11-07 (Step 03)

The first business rules arrive in Step 05, so the kernel's only production commands remain
clearly labelled diagnostics (extending ADR-0016):

- `diagnostics.recordProbe { label }` (unchanged) changes state at once.
- `diagnostics.scheduleProbe { label, delayMs }` (1 ms – 7 simulated days) allocates a
  `probe:<n>` ID and schedules a notable `diagnostics.probeDue` event; when it fires it draws a
  token from the `diagnostics` random stream. This exercises command → event queue → seeded RNG
  → journal → fingerprint in the real application. At most 100 probes may be pending
  (`COMMAND_REJECTED` beyond that), the first business-rule refusal in production code.
- `diagnostics.injectFault` is now executed by the kernel too: `handler-exception` stages an ID,
  a random draw, an event and a state change and then throws, and the tests assert that the
  snapshot, including both fingerprints, is unchanged.
- **Default epoch:** Monday 1 January 1996, until world creation (Step 07) and scenarios
  (Step 31) let the player choose. This is a FreeIndustry default, not an original rule.
- The development shell shows the clock (date, time, speed, elapsed time, last advance), the
  speed and advance controls, pending events, journal counts, seed and both fingerprints. It
  is still the development shell; the classic desktop is Step 06.

## ADR-0025 — The checkpoint format and the domain state type move out of `simulation`

**Status:** Accepted · 2026-11-07 (Step 04)

Persistence may import `domain`, `catalog` and `shared`, but not `simulation` (ADR-0004). To
store a world it needs two things that lived in `simulation`:

- **The encoded checkpoint** (kernel state and journal entries as JSON with decimal-string
  bigints) is now `src/shared/world-checkpoint.ts`: TypeScript types plus the Zod schema the
  kernel validates on restore. It is a data contract between the two layers, like the IPC
  DTOs. Field names and nesting are unchanged, so every fingerprint is unchanged (the Step 03
  property tests pass as before). Journal entries are now a strict discriminated union
  (command | event) instead of one shape with optional fields.
- **`FreeIndustryState`** (the domain state, one slice per system) is now
  `src/domain/world-state.ts`, so persistence stores each slice relationally from typed domain
  data (ADR-0026).
- The kernel gains `encodedState()` and `encodedJournalFrom(seq)` (for incremental recovery
  checkpoints), exports `KERNEL_FORMAT_VERSION`, and `restore` accepts `unknown` (it validates).

The boundary table in ADR-0004 is unchanged.

**Rejected:** letting persistence import `simulation` (the storage layer would depend on the
engine it stores, and on the rules, which change most often); storing the domain state as the
rules' JSON (spec §10.2 forbids core state as an opaque blob).

## ADR-0026 — Save files: one SQLite database per slot, relational schema, verified twice

**Status:** Accepted · 2026-11-07 (Step 04)

**One file per save** (`<userData>/saves/<saveId>.fisave`), holding exactly one world. A save
can be exported, imported or backed up as one file, and a damaged save cannot affect another.
Save IDs are plain file stems (`save-<uuid>`, `autosave-1` to `autosave-3`, `recovered-<uuid>`);
names are shown to the player and stored inside the file.

**Save format 1** (`src/persistence/schema-v1.ts`, all `STRICT` tables):

| Group                 | Tables                                                            | Notes                                                                    |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Identity and versions | `save_metadata`, `worlds`, `schema_migrations`                    | One row each (singleton keys); rules, kernel, RNG and content versions   |
| Kernel state          | `world_snapshots`, `id_counters`, `rng_streams`, `pending_events` | Clock, revision, sequences, fingerprints; queue indexed in pop order     |
| Journal               | `journal_entries`, `journal_facts`                                | The spec's `command_log` and `simulation_events` are the two entry kinds |
| Domain (Step 03)      | `diagnostics_state`, `diagnostics_last_fired`                     | Each later system adds its own tables                                    |
| Presentation, history | `workspace_settings`, `audit_events`                              | Outside every fingerprint                                                |
| Recovery log only     | `recovery_commands`, `recovery_clock`                             | Empty in save slots (ADR-0028)                                           |

- Integers are SQLite 64-bit INTEGERs read as `bigint` (`defaultSafeIntegers`); values outside
  int64 are refused before writing. CHECK constraints encode ranges and the command/event entry
  shapes; foreign keys tie facts to journal entries and the snapshot to its world.
- JSON columns hold only free-form payloads (command, event and fact data, workspace values),
  each `json_valid` and validated by its own schema when used. Everything else is queryable;
  tests query journal kinds, pending event types and domain columns directly.
- Wall-clock timestamps (`saved_at`, `created_at`, audit times) are informational and never
  enter a fingerprint.

**Save image** (`src/persistence/save-image.ts`): world identity (a stable `worldId` UUID,
distinct from the per-load world instance ID of ADR-0013), the kernel image, the typed domain
state, the journal, the fingerprints, workspace settings and the audit trail (created, saved,
autosaved, loaded with any upgrade, recovered).

**Verified on every write and every load.** A write goes to a temporary file, which is checked
(SQLite `integrity_check` and `foreign_key_check`, an exact schema match, and structure: one
world, a contiguous journal, counts that agree with the snapshot), read back, and handed to the
worker, which **restores the world in the kernel and requires both fingerprints to equal the
saved ones**. Only then is it renamed over the slot. Loading repeats every check. A mapping
bug, a damaged file or a tampered value therefore fails loudly; nothing is repaired or silently
dropped (spec §10.4).

**Rejected:** one database holding every save (export becomes row copying, and one corruption
affects all saves); the kernel checkpoint as a JSON blob (spec §10.2); trusting a write without
reading it back (the old save would already be gone).

## ADR-0027 — Atomic writes, migrations, compatibility and one writer

**Status:** Accepted · 2026-11-07 (Step 04)

**Atomic replace.** A save is written in one IMMEDIATE transaction to `.~<id>.<token>.tmp` in
the saves directory (same volume), verified (ADR-0026), closed and renamed over the slot. The
rename is retried briefly on the transient EPERM/EBUSY that Windows reports while an indexer or
virus scanner holds a file. Any failure deletes the temporary file and reports `WRITE_FAILED`
("the previous save is unchanged" or "nothing was saved"). Leftover temporary files are deleted
when the store starts. Slots use the rollback journal (`journal_mode=DELETE`,
`synchronous=FULL`): written once and closed, each file is complete on its own at rest.

**Migrations** (`src/persistence/migrations.ts`). `PRAGMA application_id` = `FIND` marks a
FreeIndustry save, `PRAGMA user_version` is the save format, and `schema_migrations` records
each step with the build that ran it. Migration N takes format N − 1 to N, with an optional
precondition, in its own transaction together with a `foreign_key_check` and the version bump.
Foreign keys are off while migrating, as SQLite requires for table rebuilds. An older save is
upgraded **on load**: it is first copied to `saves/backups/<id>.format-<n>.<time>.fisave`, the
upgrade runs on a temporary copy, and the copy replaces the slot only after it passes the
integrity checks. A failed upgrade leaves the original byte-for-byte unchanged. A newer format
is refused, never downgraded. Only format 1 exists today; the upgrade path is tested with
test-only migrations to format 2, against both generated saves and the frozen fixture.

**Compatibility.** A schema upgrade changes how a world is stored, not how it plays. A world
made under other rules (ID or version), another kernel format, RNG algorithm or content version
would continue differently, so it is refused with a sentence that says which and what to do.
When a later step bumps `FREEINDUSTRY_RULES.version`, it must either ship a domain conversion
with a fixture test or keep refusing older worlds; the frozen fixture test fails until it
decides. (Step 05 changed the save format but not the rules, so old worlds upgrade and continue;
see ADR-0033.)

**Frozen fixtures.** `tests/fixtures/saves/format-1-pending-probes.fisave` is a real save written
by this build with `scripts/write-save-fixture.ts`, which refuses to overwrite it. Its test locks
the fingerprints at the save and at the end of the day. Every later build must keep loading it,
or upgrade or refuse it deliberately.

**Copies use `VACUUM INTO`** (export, import and pre-upgrade backups), never a raw file copy.
It is SQLite's own transactionally consistent copy, which meets the intent of spec §10.1 ("do
not copy a live `.db` file alone while WAL may contain uncheckpointed changes"), and it is
synchronous, so a copy can never interleave with a command or a clock tick in the worker. The
spec names the online backup API as one option; that API is asynchronous in better-sqlite3,
which would let commands run against a world mid-copy or force a request queue, for no benefit
at these file sizes. Revisit if Step 33 measures copies long enough to stall the clock.

**Untrusted files.** Every connection sets `trusted_schema=OFF`. An imported file is checked,
including the exact-schema comparison that rejects any trigger, view or table this build did
not create, **before** any migration runs against it, and only a verified copy is added.

**One writer.** Only the worker opens SQLite (lint-enforced, ADR-0004). Main takes
`app.requestSingleInstanceLock()`, which is keyed to `userData`, so there is one FreeIndustry per
profile; a second launch focuses the first window. The gateway allows one save, load, export or
import at a time (`BUSY` otherwise), and the worker handles each synchronously.

**Rejected:** in-place writes to existing slots (an unverified write would replace a good save);
migrating the original in place (a crash mid-upgrade would leave only a hot journal between the
player and the save); lock files of our own (SQLite and the single-instance lock already cover
it).

## ADR-0028 — Durability: saves, rolling autosaves and a write-ahead recovery log

**Status:** Accepted · 2026-11-07 (Step 04); intervals provisional

The snapshot-plus-event-log policy of plan Step 04:

- **Manual saves** write the full snapshot and the full journal. The journal is append-only and
  lets every save be checked against its own history (journal fingerprint).
- **Autosaves** rotate over `autosave-1` to `autosave-3`, replacing the oldest: every 5 minutes
  of wall time while the world has changed since it was last written, on a clean shutdown
  ("Autosave on exit"), and before a load replaces a changed world ("Autosave before load"),
  so loading never silently discards play. Autosaving changes nothing in the world.
- **The session recovery log** (`<userData>/recovery/session.fisave`, WAL,
  `synchronous=NORMAL`) holds a checkpoint of the running world, refreshed incrementally
  (snapshot replaced, only new journal entries appended) after every save and every 200 logged
  commands. **Each accepted command is appended before its receipt leaves the worker**, so a
  command the player saw accepted survives a crash. A clock mark, written at most every 2 s of
  wall time while time moves, records how far the simulation ran. A clean shutdown deletes the
  log.
- **After a crash**, the next worker finds the log, restores the checkpoint, replays each command
  at its recorded simulation time (checking revision and time), advances to the clock mark,
  verifies, and writes a **"Recovered session"** save. The player decides whether to load it;
  nothing loads automatically. A log with nothing newer than its checkpoint is deleted. A log that
  cannot be replayed is kept as `recovery/failed-<time>.fisave` and the player is told.
- What can be lost: simulated time after the last clock mark (at most 2 s of wall time) and a
  command the worker never confirmed. A JavaScript crash in the thread (ADR-0014) leaves SQLite's
  files consistent; the integration and E2E tests kill a real worker thread and recover from its
  log.

**Loading** replaces the world only after every check passes, under a new world instance ID (so
commands prepared for the old world are refused, ADR-0013), with the clock paused. A failed load
leaves the running world exactly as it was. "Unsaved changes" compares the state hash with the
last save or load made by the player; autosaves do not clear it.

**IPC** (protocol v1, additive): bridge `saves` = `list`, `save({ name, saveId | null })`,
`load(saveId)`, `exportSave(saveId)`, `importSave()`; bridge `workspace` = `get` and
`set({ key, value | null })`. Export and import paths come from native dialogs in main and go
only to the worker; the renderer never sends or receives a path. New error codes
`SAVE_NOT_FOUND`, `SAVE_INCOMPATIBLE`, `SAVE_CORRUPT` and `SAVE_FAILED`; host event
`saves.changed`; `WorldSnapshot.session` (world ID, saved-as, unsaved changes, recovery state,
notice). Persistence requests time out after 60 s instead of 10 s, and a graceful stop waits up
to 30 s for the shutdown autosave.

**Workspace settings** are per save, keyed (`window.personnel`), JSON values up to 16 KiB, at
most 256 keys, stored with the save and in the recovery log, and never journaled or
fingerprinted. The classic window manager of Step 06 is their first consumer; until then only
tests use them.

**Rejected:** loading the recovered world automatically (the player may prefer a manual save);
autosaving on simulated time (a simulated day is 2.4 wall minutes at Fastest but 72 at Normal);
logging commands without refreshing checkpoints (replay time would grow without bound).

## ADR-0029 — Step 04 limits and deferrals

**Status:** Accepted · 2026-11-07 (Step 04)

- **The journal is never compacted.** Each save holds the full history, so saves grow with a long
  game. Step 33 measures save size and write time, and may introduce snapshot-only saves with an
  archived journal (a new save format with its own migration).
- **Saves are synchronous** in the worker. A large save pauses the pacing timer briefly; the
  pacer's catch-up cap (ADR-0023) bounds the effect, which cannot change outcomes. Step 33
  measures it.
- **No delete or rename of saves yet.** The development shell's Saves panel stands in for the
  File menu and dialogs of Step 06.
- **`contentVersion` is null** until content packs exist (Step 29).
- **ADR-0012's open question** (a native SQLite crash would take the app down, because the worker
  is a thread): no native fault occurred in any unit, integration, E2E or packaged run. The worker
  stays a `worker_threads` thread; the recovery log covers the JavaScript crashes that do happen.
- `diagnostics.injectFault` commands in a journal (fault-injection test builds only) replay as
  no-ops during recovery; production builds cannot issue them.

## ADR-0030 — Money: integer cents, explicit limits, decimal strings across JSON

**Status:** Accepted · 2026-11-08 (Step 05)

Spec §8.1 requires integer minor units; §10.3 requires defined money limits that fit SQLite's
signed 64-bit INTEGER. `src/shared/money.ts`:

- **Unit:** whole US cents, held as `bigint` in the domain, stored as SQLite INTEGER, and carried
  through IPC and the journal as canonical decimal strings (`positiveCentsString`, the existing
  `bigint-codec`). There is no floating-point money anywhere. Renderer input such as "$2,500.50"
  is parsed to cents as text (`money-input.ts`), and the worker validates it again.
- **Limits:** one invoice, payment or ledger line is at most $100 billion (10¹³ ¢); no account
  balance may exceed $10 trillion (10¹⁵ ¢) either way. Both are far inside int64, so no sum the
  books keep can overflow. A posting that would cross a limit is refused as a business rule,
  never wrapped or clamped. FreeIndustry values; ledger OR-78 records the original's reported
  overflow defect, which this rules out.
- **Display:** `formatUsd` works on the integer cents ("$1,234.56", "-$0.05"), so nothing is ever
  rounded for display. Currency is USD until the display options of Step 31.

A defect found while testing: Zod 4 runs `.refine` even after a `.regex` check has failed, so the
bound check called `BigInt("12.50")`, which threw inside validation (main answered
`INTERNAL_ERROR` instead of `INVALID_PAYLOAD`). The refinement now guards itself; regression tests
are in `ledger.test.ts` and `ipc-gateway.test.ts`.

**Rejected:** `number` cents (unsafe above 2⁵³ and invites float arithmetic); a decimal library
(a dependency for what integer cents already do exactly); fractional cents (no current rule needs
them; inventory cost layers in Step 18 may introduce a separate, explicit fixed-point unit).

## ADR-0031 — The company and its double-entry books

**Status:** Accepted · 2026-11-08 (Step 05)

**One player company per world**, founded by the command `company.found { legalName,
presidentName, startingCapitalCents }` (spec §3.1 step 5). It allocates `firm:1`, the president as
`person:1`, and the president as the owner counterparty `party:1`, opens the chart of accounts and
posts the capital: Dr Cash at bank, Cr Owner's capital. Names are trimmed, 1–60 characters, no
control characters. Capital is $1,000 – $100,000,000 (provisional FreeIndustry bounds until New
Company and scenarios, Steps 07 and 31). Financing is `owner-funds` only; loans and investors are
banking (Step 25). Nothing else exists: no property, people, machines or stock. Rival firms
(Step 21) will be a separate slice.

**Chart of accounts** (`STANDARD_CHART`, copied into each company so that a later chart change
cannot silently rewrite an existing company's books): 1010 Cash at bank, 1100 Accounts receivable,
1400 Security deposits paid, 2000 Accounts payable, 3000 Owner's capital, 4000 Sales, 6100 Rent
expense. Only accounts current rules post to; later steps add theirs (inventory, payroll,
equipment, loans), and Step 18 completes the general ledger.

**Ledger rules** (`src/domain/ledger.ts`): every entry is balanced and has at least two lines, each
a positive debit or a positive credit. Entries are immutable, append-only and in time order
(Step 18 adds reversing entries). Each names the business event that caused it in a unique
`sourceKey` (the invoice or payment ID, or `firm:1/opening-capital`), so no event can be posted
twice, and any entry that moves cash names its counterparty. Balances are stored per account,
debit-positive, and must equal the sum of their lines. **Cash can never go below zero**: there is
no overdraft until credit exists. A malformed posting is a bug in a rule and throws (the kernel
rolls the command or event back); an overdraft or a limit breach is a business refusal.

**Documents** (`src/domain/invoicing.ts`): an invoice is `payable` (Dr expense/asset lines, Cr
Accounts payable) or `receivable` (Dr Accounts receivable, Cr revenue lines); its lines may not post
to the control accounts (cash, receivables, payables). A payment settles part or all of one
invoice: Dr Payables / Cr Cash going out, Dr Cash / Cr Receivables coming in. It is refused, with
nothing applied, when the invoice is unknown or settled, the amount exceeds what is outstanding,
or, for an outgoing payment, the funds are not available now ("Insufficient funds: $X available,
$Y needed", with the amounts as details). Revenue recognition and cash timing are separate (spec
§8.1). A payment settles exactly one invoice; allocating one payment across several (the spec's
`payment_allocations`) waits for a rule that needs it.

**Player command** `finance.payInvoice { invoiceId, amountCents }` pays a payable. Receivables are
implemented and tested in the domain, but nothing raises one until sales (Step 16), and the
customer pays them, not the player.

**Invariants** (`companyProblems`, run on every restore and after every step of the property tests):
the ledger re-derives exactly; Accounts payable and receivable equal what is outstanding on the
open invoices; each invoice and payment is recorded by its own entry; payments add up to each
invoice's paid amount; obligation occurrences are invoiced once each; and **no unexplained cash**:
the only entries that touch cash are the opening capital and recorded payments, and cash equals the
capital plus incoming less outgoing payments.

**Rejected:** a global ledger keyed by firm now (only one company exists; the rival ledger shape is
a Step 21 decision); keeping balances only as derived values (the books keep them, and the
invariant proves them); signed single-amount lines (the spec's debit/credit columns read more
plainly and match its DDL); letting a payment overdraw and flagging it (money created by an
overdraft is what design law D08 forbids).

## ADR-0032 — Obligations, standing orders and overdue bills

**Status:** Accepted · 2026-11-08 (Step 05)

Plan Step 05 asks for rent and deposit obligations as domain events. `src/domain/obligations.ts`:

- An **obligation** commits the company to pay a counterparty: `rent` (booked to Rent expense) or
  `security-deposit` (an asset, because it is refundable); `once` or `monthly`; 1–120 occurrences;
  payment terms 0–90 days; with or without a standing order.
- **Schedule:** a monthly occurrence falls on the same day of the month and time of day as the
  first, clamped to short months (31 January → 29 February 1996 → 31 March), using the integer
  calendar (`addCalendarMonths`). Each occurrence is its own scheduled event: there is no midnight
  batch and no catching up of several months at once (spec §9.1).
- **Events** (lane `accounting`): `finance.obligationBill` raises the payable invoice for exactly
  the next occurrence at its issue time, and schedules its due event and the next bill.
  `finance.invoiceDue` is notable, so "Next event" stops there. A bill already settled is left
  alone; a bill under a standing order is paid by the bank if the funds are available; otherwise
  the bill becomes **overdue**, explicitly, with a journal fact recording the amount, the funds
  available and whether a standing order was refused.
- **Insolvency in Step 05** is a visible condition, not yet a consequence. The read model reports
  open and overdue payables and the **shortfall** (overdue bills the available funds cannot
  cover), and the shell shows an alert. Nothing is ever overdrawn and no bill is waived. Late fees,
  default, creditor action and credit are banking (Step 25, ledger OR-63).
- **Who creates obligations:** leases (Step 07). Until then the only producer is the clearly
  labelled development command `diagnostics.addTestObligation`, which commits the company to a
  schedule with a fictional "Diagnostic landlord" so the real rules can be exercised in the app
  and the E2E tests. It only ever moves money out of the company, so it cannot create money. It
  goes once leases exist.

**Rejected:** a monthly periodic process that scans every obligation (ties unrelated obligations to
one cycle and does work while none exist); paying every bill automatically when cash allows (the
player decides, D07; a standing order is the explicit per-obligation choice); refusing a bill the
company cannot pay (a landlord bills regardless; the shortfall is the honest outcome).

## ADR-0033 — Save format 2; the rules version stays 1

**Status:** Accepted · 2026-11-08 (Step 05)

**Save format 2** (`src/persistence/schema-v2.ts`, migration 2) adds relational, queryable tables
(spec §10.2): `company`, `counterparties`, `ledger_accounts`, `ledger_entries`, `ledger_lines`,
`obligations`, `invoices`, `invoice_lines`, `payments`. The spec's accounting `journal_entries` and
`journal_lines` are named `ledger_entries` and `ledger_lines`, because `journal_entries` already
holds the kernel's command and event journal (ADR-0026). Each entity row's `ordinal` primary key
equals the number in its ID (checked), so lists read back in creation order. The DDL enforces
single-row rules (one-sided lines, paid ≤ total, due ≥ issue, one invoice per obligation
occurrence). `integrity.ts` adds what DDL cannot: every entry balances, every balance equals its
postings, every invoice equals its lines and its payments, and no company rows exist without a
company. The kernel's invariants and fingerprints catch the rest: a consistently altered opening
capital passes every SQL check and is still refused on load (`company-books.test.ts`).

**The rules version stays 1.** Its definition (ADR-0019) is "bump whenever a change would make old
checkpoints play out differently". Step 05 only added commands, events and a state slice; no world
made before it contains a company or a finance command, and its diagnostics play exactly as
before. To keep their fingerprints too, the company slice is **left out of the encoded state while
no company exists** (absent, not `null`). As a result:

- The frozen Step 04 fixture `format-1-pending-probes.fisave` is upgraded to format 2 on load, with
  a backup, and still reaches its locked save-time and end-of-day fingerprints: the first real
  migration of a real old save.
- A new frozen fixture, `format-2-company-books.fisave`, locks a company mid-play (a paid deposit,
  standing-order rent, an overdue bill, bills pending) to fixed fingerprints 75 days later.
  `scripts/write-save-fixture.ts` now writes it. The Step 04 version of the script (in the
  repository history) wrote the format 1 fixture, which this build could not reproduce.

**Compatibility is judged before upgrading.** `SaveStore` now reads an older-format save's header
(the header tables exist in every format) before upgrading it. A world this build cannot continue
is refused with the file left byte-for-byte unchanged and no backup made, instead of being upgraded
and then refused. Listing shows it as `incompatible` rather than `needs-upgrade`.

**Known limitation:** a recovery log left by a crash in a format 1 build is refused by this build
("uses save format 1") and kept as `recovery/failed-<time>.fisave`, with the player told (the
existing ADR-0028 path). Upgrading crash logs across builds is not worth the risk for a
development-only transition.

## ADR-0034 — Account inspection read model and the development-shell Company panel

**Status:** Accepted · 2026-11-08 (Step 05)

Plan Step 05 asks for "an internal account inspection read model to validate journal state before
introducing polished reports". `WorldSnapshot.company` (`src/shared/ipc/company.ts`), null until a
company is founded, is built by the worker (`src/worker/company-view.ts`) from the books: identity
and financing; liquidity (cash, available funds, credit of zero, open and overdue payables and
receivables, the shortfall); every account with its debit-positive balance; the trial balance
totals and whether they agree; the latest 25 ledger entries with their lines; every open invoice
plus the 10 latest settled ones; and every obligation with its next bill date. Money is cents
strings and dates are the world calendar ("1996-02-29"). Main validates it with the rest of the
snapshot (strict Zod, bounded lists).

The development shell gains a **Company** panel: a founding form; the trial balance, bills (with
**Pay** on open payables), obligations and recent entries; a shortfall alert; and, under the
heading "Accounting diagnostics (development only)", the test-obligation form. It computes no
balances; it only formats what the worker sent. The classic windows of Step 06 replace the panel,
and the full reports, drill-downs and CSV export are Step 18.

**Rejected:** sending the whole ledger in every snapshot (grows without bound; drill-down queries
belong with the Step 18 reports); computing totals in the renderer (the renderer must not derive
business state).

## ADR-0035 — The classic desktop: a renderer window manager, layouts kept with each save

**Status:** Accepted · 2026-11-08 (Step 06)

Spec §3.2 asks for a menubar, toolbar and status bar around a factory viewport, with management
windows that open over it, overlap, move, resize, minimize, maximize within the application,
close and reopen, tile and cascade, and whose bounds, stacking order, last tab and filters are
kept per save/profile.

**Drawn by the renderer.** The menubar, toolbar, status bar and windows are React components in
`src/renderer`. Electron's own application menu is removed (`Menu.setApplicationMenu(null)`):
it was only hidden (`autoHideMenuBar`), so Alt and F10 would have opened it over the renderer's
menubar, and it carried Reload and DevTools into packaged builds. Unpackaged builds keep F12 for
DevTools through a `before-input-event` handler. On Windows, text fields keep their native
editing shortcuts without a menu.

**A pure window model.** `src/renderer/app/desktop/window-model.ts` holds the layout (each
window's open flag, restore bounds, mode and view; the stack of open windows, back to front)
and every operation as pure functions, property-tested with fast-check: the stack always lists
exactly the open windows once each; no window is ever smaller than its minimum size; every
title bar stays reachable inside the workspace (at least 64 px horizontally, all of it
vertically), so no window can be lost off-screen; a minimized window is never the active one;
closing and reopening restores bounds and view exactly. Coordinates are integer CSS pixels.
Maximized windows fill the workspace and keep their restore bounds. More than three windows
tile as a grid; a tile smaller than a window's minimum size gets the minimum.

**Where layouts live.**

- **Per save:** the whole layout is one workspace setting, `desktop.layout`, in the store of
  ADR-0028. It travels with every save and the recovery log, and it is outside every
  fingerprint and the journal. Moving windows therefore cannot change an outcome, and does not
  make the world "unsaved" (the E2E gate checks both).
- **When the world changes** (load, worker restart; keyed on the world _instance_ ID, which
  changes on every load, even of the same world), the renderer reads the new world's layout. A
  world with none (a new world) keeps the layout on screen and stores it at once, so a save
  made straight away holds it.
- **Writes** follow a change after 300 ms of quiet (a drag commits once, when it ends) and are
  **flushed before a save or a load**, so a save always holds the layout on screen and a late
  write can never land in the next world.
- **Per profile:** the last layout used, and the UI scale, are kept in the renderer's own
  `localStorage` (Electron stores it under the profile's userData). A new session starts from
  them. They are presentation preferences, never world state, and never reach the worker.
- A stored layout is **untrusted input** (a save may be imported from anywhere): it is
  validated strictly with Zod, and anything malformed is ignored as a whole. Windows a newer
  build added are dropped; windows a save does not mention get their defaults. The largest
  possible layout stays well inside the 16 KiB workspace value limit (tested).

**UI scale** (100–200 %, View menu) applies CSS `zoom` to the whole desktop, sized so the
zoomed desktop exactly fills the window. Pointer movement is divided by the scale, so a dragged
window follows the pointer exactly; window bounds stay in unscaled CSS pixels and are therefore
the same at every scale. Verified in the real app at 125 % and 150 % (drags track the pointer to
the pixel; maximized fills the workspace to within sub-pixel rounding).

**Keyboard.** Alt (alone) or F10 moves to the menubar; Alt+letter opens a menu; arrows, Home,
End, Enter and Escape navigate. Ctrl+S, Ctrl+Shift+S, Ctrl+O, Ctrl+F4 (close), Ctrl+F6 /
Ctrl+Shift+F6 (next/previous window), Shift+F5 (cascade), Shift+F4 (tile), Pause (pause/run).
Each window has a system menu (the box at the left of its title bar, or Alt+Minus) whose Move
and Size commands move or size it with the arrow keys, as classic Windows MDI windows did. These
key assignments are FreeIndustry's own (ledger OR-04).

**CSP.** The renderer validates layouts with Zod, whose fast path compiles validators with
`new Function`. Under the renderer's CSP (no `unsafe-eval`) Zod probes for that, which raises a
CSP violation report, and falls back. The renderer entry sets `z.config({ jitless: true })`, so
the interpreted validators are used directly and the app raises no CSP violation (asserted in
the E2E gate). Main and the worker are unaffected.

**Rejected:** native Electron menus (window chrome outside the classic desktop the spec
describes, and unaffected by the UI scale); one workspace key per window (more writes for the
same data, and a half-written layout would be possible); keeping layouts only in the profile
(the spec asks for per-save layouts, and the gate for "loading restores their layout"); a
window-manager library (a dependency for some 400 lines of pure, tested code); Electron
`webFrame` zoom (a new preload bridge for what CSS zoom does); `localStorage` for anything
authoritative.

## ADR-0036 — Step 06 windows, honest placeholders and the status bar

**Status:** Accepted · 2026-11-08 (Step 06)

**The development shell becomes the desktop.** Its panels become windows: **Company** (founding
and the company profile), **Accounts** (trial balance and ledger entries, the ADR-0034
inspection read model), **Bills and Obligations** (with Pay), **Saved Games** (with Save As,
Import, Load, Overwrite, Export) and **Simulation Diagnostics** (world identity and
fingerprints, the kernel probes and the test obligation of ADR-0032, under Help and labelled as
development instruments). The Saves panel's inline form becomes File → Save As (a modal dialog);
File → Save overwrites the current save when it is one of the player's own and asks for a name
otherwise. Nothing computes a business value: sorting and filtering only reorder or hide what the
worker sent (a filtered trial balance says its totals are for every account).

**The factory viewport** is mounted once as the workspace background. There is nothing to draw:
no premises exist until Step 07, geometry is Step 08 and the PixiJS renderer is Step 09, which
will mount its canvas in it. Until then it says "No facility" plainly instead of showing a
picture of a factory that does not exist.

**No fake functionality.** The menubar has all fifteen menus of spec §3.2 and the toolbar all
nine buttons. Commands for systems that do not exist yet (city, catalog, personnel, purchasing,
sales, contracts, research, bank, loans, statements, the inbox) are listed **disabled**, each
with "Not built yet: …" as its tooltip, and cannot be chosen by mouse or keyboard; menus with no
working system have no enabled command. A unit test enumerates the menus and checks that every
enabled command does something and every disabled one says why.

**Status bar** (spec §3.2): date and time, facility ("none"), cash, credit (the ADR-0034 credit
of zero), alerts, selected object ("none" until objects exist), speed, simulation state, and the
last file message. Alerts come only from real state: the worker stopped, a simulation fault, an
overdue shortfall or overdue bills, a persistence notice. Clicking one opens the window that
explains it. Critical conditions (the worker stopped, a simulation fault) are message boxes over
the workspace with the actions available (Restart worker).

**Inbox (ledger OR-56).** The ledger's stage column puts memos at Step 06, but `plan.md` puts
inbox memos at Steps 22 and 30, and nothing produces a memo yet (no staff, applicants, suppliers
or customers). Step 06 builds the notification components and the status-bar alerts; the Inbox
toolbar button stays disabled until there is something to read. Recorded in the ledger's change
register.

**Rejected:** keeping the development panels beside the windows (two ways to do the same thing);
hiding unbuilt menus entirely (the spec lists them, and a disabled command with a reason is more
honest than a missing one); drawing a placeholder factory floor in the viewport.

## ADR-0037 — Data-driven cities and property, embedded in each world

**Status:** Accepted · 2026-11-08 (Step 07)

Plan Step 07 asks for data-driven cities and districts with rents, labour, transport, buyers,
suppliers and rivals, and real properties with real dimensions, access, price and terms.

**Content.** `content/manifest.json` names the pack (`freeindustry-base`, version 1), its
real-estate files and its scenario file. Each `content/real-estate/<city>.json` holds one
fictional city (population, labour force, unemployment, prevailing wages for four labour
classes, a position on a schematic regional map), its districts (site plan in metres, road
distance to a highway junction, rail siding, streets), the businesses established there
(manufacturer, supplier or buyer, with a trade) and its properties. A property has an
address, a kind (garage, workshop, commercial unit, industrial unit, warehouse, factory), its
position on the district plan, its **floor outline in integer millimetres** (any simple
rectilinear polygon), clear height, floor loading, power (kVA, phase), water and gas, doors
(each on an outline edge at a measured offset, with width and height), permitted uses,
landlord, monthly rent, deposit in months of rent, minimum and maximum lease term, and
optionally the business that occupies it. `content/scenarios/scenarios.json` holds the
scenarios. Everything is FreeIndustry's own invention: three fictional cities (Harlow Falls,
Ohio; Port Calder, Michigan; Cedar Bluff, Texas), six districts, 41 properties (27 vacant)
and 17 businesses. No data comes from the original game (ledger OR-01, OR-83).

**Validation** (`src/catalog/content-schema.ts`) parses every file with strict Zod schemas
and then checks what a schema cannot: duplicate identifiers, references to unknown
districts or businesses, a business occupying two properties, outlines that are not simple
rectilinear polygons (`src/domain/geometry.ts`), doors that do not fit their wall or are
taller than the building, a missing personnel door, impossible terms or deposits, buildings
outside their district site, overlapping each other or standing on a street, and scenarios
that could not be played (bad epoch, duplicate ID, a quick start in an occupied or unknown
property, on a term the listing does not offer, or that its capital cannot pay for). It
reports every problem and repairs nothing. `npm run check:content` runs it
(`scripts/validate-content.ts`, spec §13.3) and is part of `npm run check`. The JSON is
imported into the build as data (`src/catalog/base-content.ts`) and never executed.

**Embedded in each world.** A new world copies the real estate into its own state: the
kernel's `create` takes a plain-JSON **setup** that the rules' `initialState` decodes,
validates and keeps (`SimulationRules.initialState(context, setup)`). The setup itself is
not stored, because the state it produces is, and every fingerprint covers it. A later
content edit therefore never changes an existing world, which is the "content embedding"
option of spec §12.2. The world records the scenario and content version it came from. The
save-level `contentVersion` (ADR-0029) stays null: it guards worlds that _depend_ on the
build's content, and an embedded world does not. Content packs that worlds reference rather
than copy, if ever needed, are Step 29's decision.

**Floor area derives from the outline** (shoelace formula in `bigint` mm², design law D05);
nothing anywhere stores an area. Rents per square foot or metre, city averages (total
annual rent over total area) and counts are computed by the worker's read model from the
stored facts (ADR-0040).

**Rejected:** generating cities procedurally from the seed (the plan asks for data-driven
content, and hand-made districts are easier to verify); real US cities with invented data
(would read as claims about real places); referencing content by version from saves (every
content edit would make old saves unloadable); rectangles only (L-shaped buildings are
common and the spec asks for irregular shapes).

## ADR-0038 — Leases: paid on signing, rent through obligations, a refund at the end

**Status:** Accepted · 2026-11-08 (Step 07)

Spec §3.1: "Leasing must require cash for deposit/prepaid rent." `src/domain/real-estate.ts`:

- **Signing** (`signLease`) refuses, changing nothing, when the property is unknown,
  occupied by a business or already leased, when the company already holds a lease, when the
  term is outside the listing's minimum and maximum, or when the available funds do not
  cover the deposit plus the first month's rent ("Insufficient funds: $X available, $Y
  needed (deposit $A and the first month's rent $B)"). Otherwise, in one step: the landlord
  becomes a counterparty; a one-off security-deposit obligation and a monthly rent
  obligation for the whole term are added (ADR-0032); the deposit and the first month's rent
  are invoiced and **paid at once** by the player; the property is occupied by the lease.
  The deposit is an asset (Security deposits paid), the rent an expense.
- **Afterwards** each month's rent is billed on the same day of the month by the ordinary
  `finance.obligationBill` event, due at once; with a standing order (the player's choice,
  on by default) the bank pays it if the money is there, otherwise it becomes overdue with
  the shortfall shown (ADR-0032).
- **At the end of the term** a notable `realEstate.leaseEnds` event moves the company out,
  makes the property vacant again and has the landlord refund the deposit: a receivable
  invoice the landlord settles at once (Dr Cash, Cr Accounts receivable; the invoice line
  credits Security deposits paid). Known simplification: the deposit is refunded even if
  rent is overdue; offsetting arrears against a deposit, renewals, early termination,
  default and buying property belong to banking and real estate (Step 25).
- **One facility at a time.** A second lease is refused with the reason ("arrives with
  multi-site operations, plan Step 26"). The status bar, factory viewport and Company window
  show the one active lease.
- **Founding with premises.** `company.found` takes an optional `premises` (property, term,
  standing order). Founding and leasing then succeed or fail together, so the New Company
  path never leaves a company without the premises the player chose, and a lease the
  capital cannot pay for founds nothing. `realEstate.lease` leases for an existing company.
- **Invariants** (`realEstateProblems`, run on every restore and in the property tests):
  every listing is physically and commercially sound; identifiers are unique and every
  reference resolves; no business occupies two properties; at most one active lease, and a
  property is held by a lease exactly when that lease is active; each lease matches its rent
  and deposit obligations and landlord, and an ended lease its refund.
- **Facts:** `realEstate.leaseSigned` and `realEstate.leaseEnded` in the journal.

**ADR-0032 amended.** It said the development command `diagnostics.addTestObligation` "goes
once leases exist". It is **kept** as a labelled development instrument (Diagnostics window
under Help; many existing tests and the format 2 fixture use it): it exercises the
obligation, overdue and standing-order rules directly and can only move money out of the
company. Leases are now the game's own source of obligations.

**Rejected:** charging the first month through the bill event at signing time (a bill the
company cannot pay would go overdue instead of the lease being refused, contradicting spec
§3.1); a lease that silently continues after its term (free occupancy, a money leak);
founding then leasing as two commands from the New Company path (a refused lease would
strand a company without premises).

## ADR-0039 — Save format 3; the rules version stays 1

**Status:** Accepted · 2026-11-08 (Step 07)

**Save format 3** (`src/persistence/schema-v3.ts`, migration 3) stores the real-estate slice
relationally (spec §10.2): `real_estate` (scenario and content version), `cities`,
`city_wage_rates`, `districts`, `district_streets`, `businesses`, `properties`,
`property_floor_points`, `property_doors`, `property_uses` and `leases`. Who occupies a
property is stored once: `occupant_business_id`, or the company through its active lease (a
partial unique index allows one active lease per property). Leases reference the company's
obligations and refund invoice, so a lease and its rent join in plain SQL. `integrity.ts`
adds what DDL cannot: no real-estate rows without a real-estate record, no leased property
also occupied by a business, every property with an outline, every lease matching its
obligations. The kernel's invariants and fingerprints catch the rest: a consistently enlarged
floor passes every SQL check and is still refused on load (`real-estate-save.test.ts`).

**The rules version stays 1** (ADR-0033's definition). Step 07 only added commands, an event,
an optional founding field and a state slice that is left out of the encoding while absent;
worlds made before it have no real estate and play exactly as before, with the same
fingerprints. The format 1 and format 2 fixtures upgrade to format 3 on load, with a backup,
and still reach their locked fingerprints. A new frozen fixture,
`format-3-leased-workshop.fisave`, locks a leased workshop with overdue rent to fixed
fingerprints past the end of its lease. A world without real estate cannot lease ("created
before cities and property existed"); New Company starts one that has them.

## ADR-0040 — The real-estate read model and new worlds over IPC

**Status:** Accepted · 2026-11-08 (Step 07)

**Read model.** `WorldSnapshot.realEstate` (`src/shared/ipc/real-estate.ts`, built by
`src/worker/real-estate-view.ts`) carries every city with its derived figures (listings,
vacancies, average asking rent per square foot and per square metre, counts of
manufacturers, suppliers and buyers), every district with its streets, every business with
its premises, every property with its outline, area, bounding dimensions, services, doors,
uses, rent and the rent per unit area, deposit, amount due on signing, terms, status and
occupant, and every lease with its dates and next rent. All of it is computed by the worker;
the renderer formats it. `WorldSnapshot.scenarios` lists the build's scenarios. It is about
35 KB and sent with every snapshot; Step 33 measures whether to split static content into
its own cached request.

**New worlds** are a request, not a command: `simulation.newWorld({ scenarioId, seed | null })`
(bridge `simulation.newWorld`, validated strictly in main, worker request `newWorld`). The
worker builds the scenario's world (`worldSetupFor`), **autosaves the world it replaces if it
has changes not written anywhere** ("Autosave before new world"), adopts the new kernel under
a new world instance ID with a new world identity, an empty workspace and a fresh recovery
log, and answers with the new snapshot. It counts as a persistence operation in the gateway
(one at a time, 60 s timeout). An unknown scenario is `INVALID_PAYLOAD`. The seed is the
player's, or random; unpackaged test builds may fix it (`FREEINDUSTRY_WORLD_SEED`, ADR-0016),
which also fulfils ADR-0021's note that New Company would offer a seed. Each worker's first
world is the standard scenario's.

**Rejected:** founding in whatever world happens to be running (New Company after playing
would have nowhere to go); a "reset world" command in the journal (a world's history would
then contain another world).

## ADR-0041 — The Step 07 desktop: main menu, city windows, leasing, options, help

**Status:** Accepted · 2026-11-08 (Step 07)

- **Main Menu** (spec §3.1 step 1) is an ordinary desktop window, open by default beside the
  Company window and reopened from File → Main Menu, with New Company, Quick Start, Load,
  Scenarios, Options, Help and Exit. Every button does something: New Company and Scenarios
  open a dialog to choose the scenario and an optional seed; Quick Start starts the
  quick-start scenario and submits its preset founding-with-premises command against the new
  world; Load opens Saved Games; Help opens the Help window; Exit closes the app. A desktop
  window rather than a full-screen title screen keeps the classic desktop (D06) and the
  Step 06 layouts intact.
- **City Selection** compares the cities on a schematic regional map (labelled "not to
  scale") and a sortable table, with the selected city's record. **City View** shows one
  city: a district site plan drawn to scale with every building selectable by mouse or
  keyboard and a factual tooltip, a sortable listings table and the business directory; the
  selected property's record and the Lease command sit beside the plan. City, district,
  scale, tab and selection are remembered in the window's view.
- **Lease dialog** shows the listing's own figures and collects the term and standing order;
  without a company it also collects name, president and capital and submits the combined
  command (ADR-0038). It shows the worker's refusal in words.
- **Status bar** shows the leased premises as the facility; the **factory viewport** draws the
  empty interior (ADR-0042).
- **Options** holds the profile's display preferences: UI scale and **units** (US customary
  by default, metric by setting, spec §12.3). Units only change formatting; the worker sends
  integer millimetres and also rents per square metre, so no business figure is computed in
  the renderer. Sound, autosave and keyboard options are Step 31.
- **Help** is a short topic window written for FreeIndustry; searchable help and tutorials
  are Step 31.
- **Menus**: File gains New Company, Quick Start, Scenarios, Main Menu and Options; View →
  City, City → City View / Cities / Properties for Lease, Company → Premises and Help → Help
  Topics are real; the toolbar's City View is enabled. Factory layout, catalog, personnel and
  the rest stay disabled with "Not built yet".
- **Layout budget.** With nine windows, the largest possible layout exceeded the 16 KiB
  workspace value limit, so a window may now remember at most 8 filters with names of up to
  32 characters (current windows use at most four). The largest possible layout is about
  10 KB; revisit as windows are added.

## ADR-0042 — The cityscape and floor plans are SVG until the PixiJS renderer

**Status:** Needs owner review · 2026-11-08 (Step 07). The "oblique view" mentioned below is
superseded by ADR-0044: no oblique view will be built. Step 09 (ADR-0051) moved the factory
interior to PixiJS and kept the city and floor plans in SVG; that choice still needs owner
review.

Spec §4.1 and §11.3 name PixiJS as the factory and city renderer (`CityScene`), and the
dependency is installed for Step 09. Step 07 draws the district site plans, the regional
map and the floor plans as **SVG in React** instead:

- Each building is a DOM element, so it is focusable, has an accessible name and a native
  tooltip, and the keyboard can select it (spec §3.4; plan Step 31's keyboard and
  readability gate) without a parallel accessibility layer over a canvas.
- It is exercised by jsdom and Playwright directly; a WebGL canvas needs GPU mocking in
  jsdom (spec §13.4) and coordinate-based clicks in the real app.
- PixiJS v8 needs its `unsafe-eval` shim under the app's CSP (ADR-0008); adopting it is a
  piece of work of its own that Step 09 owns, together with scene diffs, pooling and the
  oblique view.

Every drawing uses a fixed number of pixels per metre (site plans 1, 2 or 4; the inspector 3;
the factory viewport 2.5 – 40 in fixed steps), never a scale fitted to the space, so relative
sizes are always true (D05). Step 09 decides whether the city stays SVG or moves to a PixiJS
`CityScene`; this ADR flags the deviation from spec §11.3 for the owner.

**Also found in Step 07 (amends ADR-0035's CSP note).** Zod checks whether `eval` is allowed
when a schema is _built_, not only when it first parses. The command registry
(`src/shared/ipc/commands.ts`), which the renderer bundles for the Diagnostics window, now
builds a nested lease schema at import time, before the renderer entry's body had made Zod
jitless, so the packaged app raised one `script-src eval` violation during start-up (the
Step 06 test listened only once the app was ready). Zod is now configured in
`src/renderer/zod-config.ts`, imported first by the entry, so it runs before any other
module. Regression: `city.spec.ts` listens from the first script (an init script and a
reload) and was shown to fail without the fix.

## ADR-0043 — The pre-commit hook fixes what it can but never blocks a commit

**Status:** Accepted · 2026-11-08 (owner request)

Spec §13 asks for a Husky pre-commit hook that runs lint-staged. It stays, but now
`.husky/pre-commit` ends with `|| echo …`, so a lint-staged failure prints a warning and the
commit still goes through. The owner needs to be able to commit and push work in progress
even when it does not yet pass every check. lint-staged still auto-formats and lint-fixes the
staged files and re-stages them. When it fails, it rolls back its own edits, so the commit
holds exactly what was staged.

The hook also passes `--max-arg-length 2000`. With lint-staged's default chunk size, a
201-file commit on Windows failed with "The command line is too long." before ESLint ran.

CI (`.github/workflows/ci.yml`) and `npm run check` remain the actual quality gates.
Nothing here blocks `git push`, and there is no pre-push hook.

Rejected: removing Husky and lint-staged. That drops two dependencies the spec names, and
it loses the automatic formatting.

## ADR-0044 — Factory interiors are drawn true top-down only

**Status:** Accepted · 2026-11-08 (owner decision). It supersedes the oblique or three-quarter
operating mode in spec §2 and §3.3 (2026-11-07 baseline), the "old-school
oblique/three-quarter operating mode" task of plan Step 09, and the "2.5D oblique
presentation" adaptation of ledger OR-03. It amends ADR-0042. Earlier text is kept and
marked superseded, not erased.

**Decision.** Every factory interior is drawn in a single **2D orthographic projection,
looking straight down at 90°**. The player sees the floor as if from directly overhead.

- **No other projections.** There is no isometric, oblique, three-quarter or perspective
  projection, no tilted camera and no simulated 3D camera rotation. Sprites never show an
  object from an angle: no side faces, no elevations, and no cast shadows that suggest an
  angled view or a directional light.
- **The camera can only pan and zoom.** Its whole state is a centre point in world
  millimetres and a zoom step from a fixed ladder of pixels per metre (ADR-0042 uses
  2.5–40). It has no tilt, pitch, yaw or rotation field and is always north-up. Zoom
  changes only how many pixels stand for a metre, the same for every building.
  World-to-screen is one affine map: screen = (world mm − camera centre) × scale + viewport
  centre. Screen-to-world is its exact inverse, so selection is a plain point-in-footprint
  test in millimetres.
- **One projection in every mode.** Layout and construction, live operation, and inspection
  all use the same projection and the same zoom ladder. They differ only in controls,
  overlays, animation and what can be clicked. Switching modes keeps the camera where it is
  and changes no world state (spec D09).
- **Orientation belongs to objects.** Rotating a machine turns its footprint on the floor
  (ADR-0045). It never moves the camera.
- **Art is drawn for the overhead view.** Machinery, furniture, workers (head and
  shoulders), forklifts, carts, pallets, racks, conveyors and stock are all drawn as seen
  from above, at their real proportions, with neutral, non-directional shading. That way a
  sprite turned through a quarter turn is still correct, and one drawing serves all four
  orientations. **The footprint is authoritative.** Art is fitted to the physical footprint,
  never the footprint to the art. A sprite's drawn extent equals the footprint it stands for.
- **Height is shown as information, not by the projection.** Drawing order follows the layer
  (ADR-0046) and then height above the floor: a pallet on forks is drawn above the forklift
  body. Raised structures (mezzanines, crane rails, upper floors) are their own level or an
  outline overlay. The view is never skewed to show them.
- **Aesthetic.** The target is a realistic, restrained industrial look: a living
  architectural floor plan with physically represented activity. Use practical industrial
  colours, readable silhouettes, true proportions and enough surface detail to recognise a
  machine and its process. Avoid cartoon exaggeration. Design law D06 (no decorative effects)
  still applies.

**City view.** District site plans and floor plans are already plan views drawn to a fixed
scale (ADR-0042). They stay plan views whichever renderer draws them. ADR-0042's open
question, whether the city stays SVG or moves to PixiJS, is unchanged.

**Fidelity.** The original reportedly showed a three-quarter view while a turn ran (ledger
OR-03, GF §5.3). FreeIndustry deliberately does not reproduce it. This is an approved
deviation, recorded in the ledger. What it keeps is the experience of watching people and
freight move through the plant, not the camera angle.

**Why.** One projection gives exact hit tests and exact footprints on screen, and it never
hides floor, ports or clearances behind tall objects. It halves the art (no second angle
per object), needs no depth sorting of overlapping sprites, and matches the to-scale plans
built in Step 07.

**Rejected:** an oblique operating view beside a top-down layout view (the earlier spec):
two drawings per object, depth sorting, ambiguous clicks on overlapping sprites, and
footprints hidden behind machines. Isometric for every mode: it distorts dimensions and
turns the construction grid into diamonds, so exact measurement on screen is lost. Free
camera rotation: a north-up plan keeps walls, doors and labels stable, and the owner asked
for pan and zoom only.

## ADR-0045 — One physical coordinate system: integer millimetres, a 500 mm grid, a 250 mm placement lattice

**Status:** Accepted · 2026-11-08 (owner decision; formalises spec §5.1–5.2 for Step 08)

**Canonical units.** Every physical length and coordinate is an **integer number of
millimetres** (a safe integer within the plan limit of `src/domain/geometry.ts`, currently
1,000,000 mm). Exact areas are **`bigint` square millimetres**, never floating point.
Feet, inches, metres and square feet exist only in display formatting
(`src/renderer/app/units.ts`, the player's Units option; spec §12.3) and are never stored.
Screen pixels, sprite sizes and tile counts are never authoritative. The simulation does not
depend on screen resolution, frame rate, window size or camera position (spec D09). No
building is ever scaled up or down to look like another (D05): at the same zoom, a garage is
drawn smaller than a warehouse.

**Facility frames.** Each level of a facility has a local floor frame. The origin is the
minimum corner of the floor outline's bounds, x runs to the right and y down the screen, as
in the Step 07 outlines. Every bundled outline already starts at (0, 0); Step 08 makes this a
content validation rule. Levels share the building's origin and carry an elevation in mm, so
the cells of a future upper floor lie directly above those below. District site positions
(metres, ADR-0037) only place buildings on the city plan. They are not part of interior
geometry.

**Construction grid.** One world-wide constant, `CONSTRUCTION_GRID_MM = 500`: every building
uses the same grid. Cell (col, row) of a level covers x ∈ [500·col, 500·col + 500) and
y ∈ [500·row, 500·row + 500) mm, an area of 0.25 m², about 2.69 sq ft. A cell's identity is
(property, level, col, row): integers derived from the coordinates. Cells are not stored as
entities. A row exists only where a cell has state of its own, such as a floor covering
(ADR-0046). Changing the grid pitch would be a rules and save-format change.

**Usable floor and partial cells.**

- The usable region of a level is its floor polygon minus structural columns, obstacles and
  forbidden zones, all exact rectilinear polygons in mm (plan Step 08).
- Usable area is the exact area of that region. It is never the cell count × 0.25 m², and
  never the bounding box.
- Each cell is **full** (inside the usable region), **partial** (0 < covered area <
  250,000 mm²) or **outside** (covered area 0). A partial cell records its exact covered
  area.
- Only full and partial cells are eligible to be selected, customised or bought. Outside
  cells, including cells entirely under a column, are not eligible.
- Example: garage `hf-canal-2` is 3,000 × 5,800 mm, so it spans 6 × 12 = 72 cells. Its last
  row is 300 mm deep: 6 partial cells of 150,000 mm² each. The usable area is 17.4 m², not
  72 × 0.25 = 18 m².

**Placement.**

- **Footprints are exact.** Equipment, furniture, racks, conveyors and fixtures have
  real-world footprints in integer mm from their catalog data. A 12 ft × 6 ft machine is
  3,658 × 1,829 mm. Footprints are never rounded to whole cells or resized to fit tiles. An
  object may stand on parts of several cells. Standing on a cell never changes that cell's
  floor covering.
- **The placement lattice is 250 mm.** A placed object's authoritative position is the
  minimum corner of its rotated footprint, in integer mm, on the 250 mm lattice. Layout
  mode snaps to the 500 mm grid by default and offers an optional 250 mm sub-grid. The
  domain refuses positions off the lattice, so every position the game produces is
  reproducible. A wall that is not on the lattice (the 5,800 mm garage) leaves a gap of less
  than 250 mm. Snapping to walls would need its own ADR.
- **Orientation is a quarter turn** about the vertical axis: 0°, 90°, 180° or 270°. A rotated
  footprint stays an exact, axis-aligned integer rectangle, parallel to the rectilinear
  walls. Arbitrary angles are rejected because they need irrational coordinates and inexact
  collision tests. Revisit with an ADR if the owner wants them.
- **Collision, fit, clearances, ports, maintenance areas, operator stations, walkways and
  utility points are tested on exact millimetre geometry**, never on cell occupancy.
- **Navigation.** Worker and vehicle positions are integer mm. A pathfinding graph (spec
  §5.2) may use its own derived resolution, but it is rebuilt from the exact geometry and is
  never the authority on where an object stands.

**Rejected:** tile coordinates as the authority (cannot represent partial cells or real
dimensions); a grid pitch per building (buildings would look inconsistent at the same zoom);
anchoring the grid to the district plan (cell identities would depend on where a building
stands in its district); placement at 500 mm only (too coarse to fit equipment into small
garages); free 1 mm placement (endless near-identical positions and ragged layouts, with no
gain at 250 mm resolution).

## ADR-0046 — Floor coverings: a separate per-cell layer, data-driven, bought through the books

**Status:** Accepted · 2026-11-08 (owner decision) for the layer model, data architecture and
development path. The four points marked **Owner review** are recommended defaults and need
the owner's confirmation before Step 09A. Data model: Step 08. Rendering: Step 09.
Purchasing and editing: Step 09A.

**Layers.** A factory consists of six conceptual layers:

1. **Structure.** Property geometry and fixed structure: outline, walls, columns, forbidden
   zones, doors, docks, levels and the **slab**, with its structural load capacity
   (`floorLoadKgPerM2`, already a property fact, ADR-0037).
2. **Floor covering.** One material per eligible 500 mm cell.
3. **Construction grid and editing overlays.** Derived and never stored. The grid can be
   shown or hidden at will.
4. **Placed objects.** Machinery, furniture, equipment and storage.
5. **Moving objects.** Workers, vehicles, stock and other things that move.
6. **Selection and feedback.** Selection marks, operating feedback and inspection overlays.

Layers 1, 2, 4 and 5 are authoritative world state. Layers 3 and 6 are presentation only.
The model fixes what is independent of what. It does not prescribe six PixiJS containers.
Changing a covering never deletes, moves or resets anything in layers 4–5. Moving or
removing equipment never changes a covering.

**Structure is not covering.** Load capacity belongs to the slab. A covering never changes
it: steel plate does not make a floor stronger. Functional covering properties (slip
resistance, durability, wear, cleaning, suitability for a process) may appear in the
material schema as optional fields. They have no effect until a step gives them a rule and
an ADR. None are planned now.

**Construction grid versus decorative pattern.** The grid is always 500 mm. A material's
visible pattern is its own: seamless epoxy looks nearly continuous, while steel plates or
concrete bays show strong joints at their own module (for example 1,000 × 2,000 mm). The
pattern is drawn in world coordinates, so joints line up across cells. Aisle lines narrower
than a cell are not coverings. They belong to zones (plan Step 15).

**Material catalog** (`content/floor-materials/`, data only, Zod-validated by
`check:content`). Each material has a stable ID, name and category (concrete, polished
concrete, painted concrete, epoxy, steel plate, diamond plate, anti-slip, safety and hazard
marking, office), an **installation price per m²** in integer cents, a **removal price per m²**
in integer cents (charged when a cell of this material is replaced), a texture set with
variants and the pattern module, and the optional inert functional fields. Adding a material
is a content change, not a code change.

**Starting surface.** Every property listing names its existing surface, a material ID
(normally standard concrete, worn concrete for the old buildings). A new lease starts with
every eligible cell in that surface, at no cost.

**State and saves.** Coverings belong to the **property**, as a physical fact of the building.
Who paid is recorded on the installation.

- Each property and level keeps a sparse map from cell to material and installation. A cell
  missing from the map has the starting surface, so a plain 21,600-cell floor stores no rows.
- Save format (the next format number when Step 08 adds the data):
  `floor_cell_coverings(property_id, level, col, row, material_id, installation_id)` with
  primary key (property, level, col, row), and
  `floor_covering_installations(id, property_id, firm_id, game_time_ms, kind, cells, area_mm2, cost_cents, journal_entry_id)`.
  Both are fingerprinted.
- Invariants: every covered cell is eligible, every material is known, and every installation
  balances to its journal entry.

**Buying and installing** (plan Step 09A).

- **Quoting.** A read-only request returns the cost of a proposed change. The layout tools
  preview the material locally before purchase. Previews are renderer state and never
  authoritative (spec §4.2).
- **Ordering.** One validated, idempotent command,
  `facility.installFloorCovering({ propertyId, level, materialId, rectangles })`. The
  rectangles are in cell coordinates, so a whole floor fits in one command. The command is
  refused, with nothing changed, if the company does not hold the property, a cell is not
  eligible, the material is unknown, or the funds do not cover the cost (with the figures).
  Cells already in the chosen material are skipped and not charged.
- **Cost.** The covered area is exact, so partial cells are charged only for their covered
  area. Initial installation is a cell going from its starting surface to a new material:
  installation price × area. Replacement is a cell going from an installed material to
  another: removal price of the old material plus installation price of the new, posted as
  separate lines. All sums are `bigint`, rounded half-up to whole cents once per order.
- **Books.** One balanced journal entry per order, keyed by the command (ADR-0031), with the
  installation and removal components distinguishable in the books and in the installation
  record.
- **Selection tools.** A single cell, a rectangle, the whole level, and a **fill**: the
  4-connected region of eligible cells with the same covering as the starting cell, bounded
  by the usable floor. The fill is computed for the preview, and the command then carries
  explicit rectangles that the worker validates again. "A whole room" is the fill until rooms
  and zones exist (Step 15).

**Owner review (recommended defaults):**

1. **Timing.** Installation completes at the moment of the order, done by an outside
   contractor with no company staff. Alternative: a scheduled contractor job with a duration
   and an area that is out of use meanwhile.
2. **Under equipment.** Replacing the covering under installed equipment is allowed and
   leaves the equipment exactly as it was. Alternatives: require the area to be clear, or
   charge a surcharge or downtime.
3. **Accounting.** Installation is capitalised as a leasehold improvement (an asset;
   depreciation over the remaining lease term from Step 18), and removal charges are an
   expense. Alternative: expense everything.
4. **End of lease.** Coverings stay with the building when a lease ends, and any
   undepreciated balance is written off then. A property relet later keeps them.

**Rendering** (plan Step 09).

- Coverings are drawn in **chunks** of cells, for example 16 × 16, each cached as one texture
  or mesh per level of detail. Only visible chunks are drawn (viewport culling). A change
  redraws only the chunks whose cells changed.
- There is never a React element per cell, and never a PixiJS display object per cell at
  ordinary zooms.
- Texture variants are chosen by a fixed hash of the cell coordinates, so they are stable
  between frames and runs without using the simulation's random streams.
- At low zoom a material is drawn as its average colour; texture detail appears as the view
  zooms in.
- The grid overlay is drawn per visible chunk, on exact cell boundaries at every zoom.

**Fidelity.** No evidence shows the original offered floor coverings. They are `EXTENDED`
(ledger OR-86).

**Rejected:** coverings as properties of placed objects (replacing a floor would touch
machines); a dense per-cell table (tens of thousands of identical rows per building);
coverings that raise structural load (would let decoration change physics); purchase as a
renderer action or a cosmetic purchase that bypasses the books (spec §4.2, D02 spirit);
folding the purchase workflow into Step 08 (it needs the renderer's selection tools from
Step 09).

**Amended by Step 08 (ADR-0047).** "Every installation balances to its journal entry" is
implemented as: the installation names an existing entry in the company's books whose
debits equal the installation's cost. It does not require the entry's source key to be the
installation ID, because cash only ever moves through an invoice and its payment (ADR-0031),
so a Step 09A order is recognised by the contractor's invoice entry.

## ADR-0047 — Building structure and exact floor geometry

**Status:** Accepted · 2026-11-08 (Step 08)

Spec §5.1 and plan Step 08 ask for parcels, interior polygons, walls, columns, doors, docks,
utility connections, levels, forbidden zones and usable floor area.

**Model** (`src/domain/facility.ts`). Each property has one **building** record in the new
facilities slice (ADR-0049): its starting floor surface (ADR-0046), its **parcel** (a
rectangle in district site-plan millimetres that must contain the building; it defaults to
the building's own footprint), its **levels**, **utility points** and **stairs**.

- **Levels.** Level 0 is the ground floor and repeats the listing's outline, clear height and
  slab rating (an invariant keeps them equal). An upper level (mezzanine, upper floor) has
  its own outline inside the ground floor's, an elevation, a deck depth, a clear height and
  its own slab rating, and needs at least one stair. Headroom under it is elevation − deck
  depth, and equipment below must fit under it. Content: one mezzanine, in the industrial
  unit at 20 Canal Street.
- **Features** are axis-aligned integer-mm rectangles on a level: `column`, `wall`
  (interior partition), `obstacle` (fixed plant, a transformer room) and `forbidden` (a zone
  where nothing may be installed). Content may give columns as a grid of x and y centre
  lines. A grid column outside an L-shaped floor is left out; one straddling a wall is a
  content error.
- **Doors and docks** stay on the listing (ADR-0037). Each door gets a clear landing inside
  it: 1,000 mm deep for a personnel door, 1,500 mm for a roller shutter, 3,000 mm for a
  loading dock (the dock's staging apron). Nothing may be installed there. Vehicle access
  outside the building is left to receiving and dispatch (Steps 14 and 16).
- **Utility points** (power intake, water point, gas meter) sit on a ground-floor wall,
  placed like doors (edge, offset, width), with 1,000 mm of working space kept clear. Every
  building has a power intake. Water and gas points need the listing's water or gas supply.
  The content's points were placed once by an authoring script beside the personnel door
  and then validated. Routing services to machines is Step 27.
- **Stairs**: a flight on the lower level (structure), a foot landing on the lower level and
  a head landing on the upper level, both kept clear.

**Exact geometry** (`src/domain/region.ts`). A level's region is its outline minus
rectangles. Cutting the plane along every x and y coordinate involved (coordinate
compression) gives elementary rectangles that are each entirely inside or entirely outside.
So the region is an exact list of disjoint rectangles, and area, overlap, containment and
per-cell coverage follow in integer arithmetic.

- The **floor region** is the outline minus columns, walls, obstacles and stair flights.
  The **usable region** is the floor region minus forbidden zones (spec §5.1). Usable area is
  the usable region's exact area.
- Each 500 mm cell's covered area is the sum of its overlaps with those rectangles. A cell is
  full, partial or outside accordingly, and the covered areas sum exactly to the usable area
  (property-tested).

**Walkways.** A person needs a clear way at least **800 mm** wide (`WALKWAY_WIDTH_MM`, a
FreeIndustry value). Reachability is computed exactly: the walker is a square of 800 mm, the
blocked set is the solid structure, everything outside the outline and every installed
footprint, and the free positions of the walker's centre are found in doubled coordinates
with each blocked rectangle grown by 799 doubled units. A gap of exactly 800 mm passes and a
799 mm gap does not. The entrances are personnel-door landings (ground floor) and stair
heads (upper levels).

- **Every building must already be walkable when empty**: content validation checks that
  every door, utility point and stair foot can be reached. A layout must keep them all
  reachable, together with every operator station and maintenance area (ADR-0048).
- The navigation graph for walking workers (Step 12) is separate. It is rebuilt from the
  same exact geometry.

**Content** (`content/real-estate/*.json`): every listing gains `surface` and `structure`.
The content pack version becomes `freeindustry-base/2`. Worlds embed their content
(ADR-0037), so existing worlds are unaffected.

**Rejected:** a raster occupancy grid (would make cells authoritative, contrary to
ADR-0045); arbitrary polygonal obstacles (rectangles compose any rectilinear shape and keep
every test exact); a walkway check by sampling (not exact, and resolution-dependent).
Forbidden zones are taken out of the usable region, as the spec says, so no equipment or
floor covering goes there, but people may still walk through them.

## ADR-0048 — Equipment: catalog, ownership, placement and its costs

**Status:** Accepted · 2026-11-08 (Step 08)

**Catalog** (`content/machines/equipment.json`, data only, validated by `check:content`):
19 FreeIndustry types, from a steel workbench to an 80-tonne injection moulding machine.
Each has a footprint in integer mm (a sliding-table panel saw is exactly 3,658 × 1,829 mm,
12 ft × 6 ft), height, weight, electrical demand in VA, three-phase, water and gas needs,
the uses its premises must permit, a dealer, a price and a rigging charge. Around the
footprint, in the type's own frame, it has **zones**: operator stations, maintenance areas,
safety clearances, and input and output ports. The names, dealers and 1996-style prices are
invented; none come from the original game (ledger OR-31, OR-32, OR-83).

**Frame.** At orientation 0 the type's width runs along x and its depth along y. Its front is
the +y side (down the plan). Orientation is a clockwise quarter turn on the plan, and a placed
item's position is the minimum corner of its turned footprint on the 250 mm lattice
(ADR-0045).

**Placement rules**, all on exact geometry (`src/domain/equipment.ts`), are reported in this
order, each with the rectangle where it fails:

1. on the 250 mm lattice; a quarter turn;
2. the footprint fits inside the walls (the message gives both the footprint and the floor's
   dimensions, or says to turn it);
3. it is clear of structure, of the clear landings and of forbidden zones;
4. it is clear of other equipment, of other items' zones, and its own zones lie on open
   floor, clear of other footprints (zones may overlap each other: a shared aisle);
5. its height fits under the clear height, including under a mezzanine;
6. its weight over its footprint is within the slab's rating (`kg × 10⁶ ≤ rating × area`,
   exact);
7. a walkway reaches every door, utility point, stair foot, operator station and
   maintenance area;
8. the premises permit one of its uses;
9. the building has the three-phase, water and gas it needs;
10. the installed demand stays within the supply's kVA.

Ports must be clear but need not be reachable yet. Conveyors and handling connect them in
Step 15.

**Ownership and money** (`src/domain/facilities.ts`, books ADR-0031):

- `equipment.purchase { equipmentTypeId, quantity 1–20 }`: the dealer becomes a supplier
  counterparty, invoices the price to **1500 Machinery and equipment** (an asset) and is paid
  at once. It is refused with the figures if the funds do not cover it. The items are the
  company's, **held by the dealer, uninstalled** (spec §5.4 `UNINSTALLED`).
- `equipment.install`: the first installation is included in the price. It needs premises
  the company leases, and every rule must hold.
- `equipment.move` (within the building, level changes allowed) and a reinstallation after
  `equipment.uninstall` are rigging jobs: the dealer invoices the type's charge to **6200
  Equipment installation and relocation** (an expense), paid at once. Removal itself is
  free. A move and an uninstall-then-install therefore cost the same. Freer moving and
  turning than the original's reported "move but not rotate" is an extension (OR-33).
- The two accounts are **opened the first time a rule posts to them** (`ensureAccount`), so
  companies founded earlier keep exactly their books.
- **At the end of a lease** the dealers take every item away before the keys are returned
  (no charge). The items are held for reinstallation elsewhere (multi-site: Step 26).
- Installing is instantaneous, done by the dealer's riggers, so no staff, transport or
  downtime are involved yet. Delivery through the dock is Step 14, and an installed item is
  idle until production (Step 13).
- Invariants re-check every installed layout in full on every restore. They also check each
  item's dealer, its purchase invoice and the invoice total.

**Rejected:** placing on purchase (the plan asks for owned equipment that must be installed);
charging a fee for removal as well (it would make a move cheaper than removing and
reinstalling); free relocation (the ledger asks for paid relocation).

## ADR-0049 — Save format 4; the rules version stays 1

**Status:** Accepted · 2026-11-08 (Step 08)

**State.** A new slice, `FreeIndustryState.facilities` (`Facilities | null`), holds the
floor materials, the equipment catalog, every building record, the owned equipment, the
covering layer and the installation records. It is null in worlds made before Step 08. Like
the company and real estate (ADR-0033, ADR-0039), it is **left out of the encoding while
absent**, so earlier worlds keep their fingerprints. **The rules version stays 1**: Step 08
only adds commands, a slice and one step at a lease's end that does nothing when the slice
is absent. A new world's setup becomes `{ realEstate, facilities }`. A bare real-estate
setup still builds a Step 07-style world, and such a world refuses equipment with the reason.

**Save format 4** (`src/persistence/schema-v4.ts`, migration 4), stored relationally:

- the catalogs: `floor_materials`, `equipment_types`, `equipment_type_uses`,
  `equipment_type_zones`;
- the buildings: `buildings`, `building_levels`, `building_level_points`,
  `building_features`, `building_utilities`, `building_stairs`;
- `equipment`: all placement columns set or all null, enforced by a CHECK;
- `floor_covering_installations`, and `floor_cell_coverings` with primary key (property,
  level, col, row), as ADR-0046 prescribes.

A plain floor stores no covering rows. `integrity.ts` adds:

- every property has a building with a ground floor and an outline;
- equipment stands only in premises someone leases;
- every installation's cost equals the debits of its entry.

The kernel's invariants catch the rest: a tampered overlap passes every SQL check and is still
refused on load.

**Fixtures.** The format 1, 2 and 3 fixtures upgrade to format 4 with a backup and reach
their locked fingerprints. A new frozen fixture, `format-4-installed-equipment.fisave`,
locks a laid-out industrial unit (a turned 3,658 × 1,829 mm saw, a bench moved on the
mezzanine, a bench held by its dealer) to fixed fingerprints past the end of its lease.

## ADR-0050 — Placement queries, the layout view and the zoom ladder

**Status:** Accepted · 2026-11-08 (Step 08). It amends ADR-0042 (the drawings stay SVG until
Step 09). Its "Layout view" section is superseded by ADR-0051 (Step 09): the factory is now
drawn by the PixiJS scene with a centre-and-zoom camera. The query and read model stand.

**Read-only query.** Layout previews need the worker's own verdict, and the renderer must
not re-implement placement rules (spec §4.2). A new request, `simulation.query`, carries a
`SimulationQuery`. It currently has one kind, `placement`; Step 09A adds the floor quote. It
is validated in main (`rendererRequestSchema`) and again in the worker (`workerRequestSchema`)
and goes bridge → main → worker, through the gateway's ordinary in-flight limit. The worker
answers from the current world without changing it, and the answer is not journalled. It
returns allowed or not, a refusal that comes before geometry, every problem with its
rectangle, the proposed footprint and zones, and the rigging charge. The bridge gains
`simulation.query`.

**Read model.** `WorldSnapshot.facilities` holds:

- the material and equipment catalogs; each type comes with its plan shape for spec-sheet
  diagrams;
- the owned items with their footprints and zones;
- for the active premises, each level's outline, usable and outline areas, cell counts, the
  eligible cells as row runs, the partial cells with their covered areas, the structure, the
  clear landings and the coverings.

The renderer formats this data; it computes no physical fact. A level's geometry is cached
per immutable level in the worker.

**Layout view.** The factory viewport draws the premises with SVG, as ADR-0042 already did,
until the PixiJS renderer of Step 09:

- everything is drawn in world millimetres inside one group scaled by pixels per metre ÷
  1000, so the drawing cannot disagree with the geometry;
- the construction grid is **one path** on exact 500 mm boundaries, clipped to the outline,
  never one element per cell; there is an optional 250 mm sub-grid, which also switches
  snapping from 500 to 250 mm;
- layout mode (View → Factory Layout, or the toolbar's Factory button) adds the grid, a cell
  inspector (full, partial or outside, covered area, material), a level selector, and the
  placement tool: the preview follows the pointer on the lattice, R turns it, Esc cancels,
  the worker's verdict and colliding rectangles are shown, and a click submits the command;
- clicking an installed item selects it, with Move and Remove;
- panning is by scrolling the viewport; a centre-and-zoom camera is Step 09.

The Equipment Catalog (Catalog menu and toolbar) lists the types with spec sheets and to-scale
diagrams, buys them, and lists owned items with Install, Move and Remove. The zoom ladder gains
an 80 px/m step so a garage can be worked at 250 mm precision.

**Rejected:** previews computed in the renderer from the read model (two implementations of
the rules would drift apart); a placement "dry run" command in the journal (a question is not
a world change).

## ADR-0051 — The PixiJS factory scene: one camera, three modes, chunked floor, a test probe

**Status:** Accepted · 2026-11-08 (Step 09). It replaces ADR-0050's SVG layout view and
amends ADR-0042 (see "City view" below, which needs owner review).

**Scene and boundary.** The factory viewport draws the premises with one PixiJS v8 scene
(`src/renderer/scenes/factory/pixi/`), loaded on demand the first time a facility is shown.
React owns presentation state (mode, camera, selection, hover, the placement preview) and
hands the scene a complete frame; the scene draws it and reports what it drew. The scene
never writes anything back, and nothing in it reaches the worker. The pure parts (camera,
floor chunk model, scene model and diffs, hit test, art, pool) live beside it with no PixiJS
import and are unit-tested in Node.

**One projection, three modes.**

- The camera is `{ centreXMm, centreYMm, zoomIndex }` and nothing else. Screen = (mm −
  centre) × px/m ÷ 1000 + the viewport's whole-pixel centre. The scene graph receives a
  uniform scale and a translation only.
- The inverse resolves to 10⁻⁶ mm, so every whole millimetre and lattice point comes back
  exactly; floating-point noise is about 10⁻¹⁴ mm.
- Operating (default), Layout and Inspection share that camera. They differ only in
  overlays: grid, sub-grid, cell inspector and placement tools in Layout; zones, keep-clear
  landings and measured footprints in Inspection; state lamps in Operating and Inspection.
  View offers the three as a radio group, and the toolbar's Factory button opens Layout.
- Dragging pans, the wheel zooms one ladder step about the pointer, + and − zoom about the
  centre, and the arrow keys pan. Centre recentres on the level. The centre is clamped to
  the level plus 2 m.
- Switching modes, panning and zooming send no command and change no world state.

**Stable selection.** Every drawn object has its entity id (`equipment:3`, `door:0`,
`feature:2`, `keep-clear:1`), and selection is a point-in-footprint test in millimetres in
every mode. The selection is lifted to the desktop. The Equipment Catalog highlights the
selected item, and its "Show on floor" selects an installed item and centres the view on it.
The status strip shows the selected item's record in every mode. Move and Remove appear in
Layout only.

**Layers and drawing order.**

- Bottom to top: floor coverings (masked to the outline), structure (columns, walls,
  obstacles, forbidden zones, the outline wall, doors), the grid, zones, equipment, then
  state lamps, selection, hover and the placement preview. Labels and measurements sit in a
  screen-space layer so text stays crisp.
- Equipment is stacked by layer, then height above the floor, then id. Nothing is sorted by
  screen y.
- Objects are applied as diffs by id (added, changed, removed). A sprite is redrawn only when
  its own object changed. Sprites, floor-chunk sprites, the temporary cell sprites used to
  draw chunks, and labels are pooled.
- Frames are drawn on demand; there is no ticker, because nothing moves until Step 12.

**Floor layer.**

- Chunks are 16 × 16 cells (8 × 8 m). Each visible chunk is drawn once into a render texture
  of whole pixels at the current zoom and shown as one sprite.
- A chunk is redrawn only when one of its cells' coverings changes or the zoom step changes.
  The model diffs successive worker views cell by cell.
- Chunks out of view are culled; up to 96 spare textures are kept.
- Level of detail: flat material colour below 20 px/m, otherwise each cell's atlas variant,
  chosen by a fixed hash of its coordinates.
- A material's joints are drawn at its own module from the level origin, so they are
  continuous across cells and chunks and independent of the grid. They are drawn only when
  at least 6 px apart.
- The grid is one graphics object of 1 px lines on exact 500 mm boundaries, masked to the
  outline. It is fainter as cells shrink on screen but present at every zoom.
- Measured on a 48,000-cell fixture: 25 display objects at 80 px/m and 213 at 2.5 px/m,
  where all 195 chunks are on screen. There is never one object per cell.

**Art.** All of it is newly authored and procedural; nothing is copied from the original
game.

- Equipment art is vector primitives in each type's own frame (front at +y). The first
  primitive is the housing, exactly the footprint, and everything lies inside it.
- The art is mapped onto the worker's footprint by the domain's exact quarter-turn mapping.
  Strokes are inner-aligned, so PixiJS's bounds of a sprite equal its footprint exactly.
- Shading is flat and neutral: a lighter top panel and a darker edge, with no side faces and
  no offset shadows.
- Floor tiles (500 mm at 128 px/m) are drawn on a canvas from each material's colour and
  texture family with a fixed seed.
- The AI-generated concept packs under `docs/art/` are not used. Their cutouts are
  approximate and not to scale, and their provenance needs the Step 35 asset audit before
  anything ships.
- Operational state: every installed item shows an idle lamp, and its record says idle until
  production (Step 13).

**Read model.** `floorMaterials` gains `textureSet` and `textureVariants` from the content.
This is an IPC read-model field only. The save format and the rules version are unchanged.

**CSP.** The scene module imports `pixi.js/unsafe-eval` first, so PixiJS compiles shaders
without `eval` under the existing `script-src 'self'`. Pixi's asset loader, which uses
workers, is not used; atlases are made from canvases. The renderer preference is WebGL, and
`preserveDrawingBuffer` is on so pixels can be read back; it costs nothing because frames
are drawn only on demand. The real app and the packaged build show no CSP violation.

**Test seams.**

- jsdom has no GPU. Jest's renderer project maps the scene module to a recording fake
  (`tests/support/fake-factory-scene.ts`), so viewport tests assert what the scene is
  given: mode, camera, objects, grid flags, selection and preview.
- The real drawing is measured in the real app through a read-only **scene probe**,
  `window.__freeIndustryScene`. It reports PixiJS's own bounds of a drawn object, pixels
  read back from the canvas, counts, and a fixture level drawing.
- The probe exists only when main starts the window with `FREEINDUSTRY_SCENE_PROBE=1`, which
  packaged builds ignore like the other test overrides. Main passes
  `additionalArguments: ['--freeindustry-scene-probe']`, the sandboxed preload reports it as
  `runtime.sceneProbe`, and the renderer installs the probe.
- A fixture changes only what is drawn. It is labelled "Test fixture drawing (not the
  world)", and it lets floor rendering be measured before Step 09A can buy coverings.
- `knip.json` no longer ignores `pixi.js`, which is now used.

**City view (needs owner review).** ADR-0042 left open whether the city moves to a PixiJS
`CityScene` (spec §11.3). Step 09 keeps the district site plans and the floor plans in SVG:
each building stays a focusable DOM element with an accessible name and native tooltip, the
plans are small, and they are already drawn to a fixed scale. A `CityScene` can follow if city
views grow to thousands of objects (Step 30). This is a deviation from §11.3's scene list.

**Rejected:**

- One PixiJS object per cell, or a React element per cell: unbounded by the view.
- Separate layout and operating scene classes: two code paths for one projection, the drift
  ADR-0044 exists to prevent.
- Using the concept-art PNGs: not to scale, not audited.
- Measuring the canvas by screenshot decoding alone: it cannot name which object a pixel
  belongs to; the probe reads PixiJS's own bounds and the pixels.
- An always-on probe: test hooks stay out of packaged builds.
