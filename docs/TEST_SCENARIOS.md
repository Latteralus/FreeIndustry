# FreeIndustry — Test Scenarios and Verification Log

How FreeIndustry is tested, which specification scenarios are covered, and what has
actually been run. Record real results only: command, date, host, outcome.

## Test layers

| Layer           | Tool                           | Location / pattern                            | Runs in                                          |
| --------------- | ------------------------------ | --------------------------------------------- | ------------------------------------------------ |
| Unit (Node)     | Jest + ts-jest                 | `tests/unit/**/*.test.ts`, `src/**/*.test.ts` | Node, no Electron/PixiJS                         |
| Unit (renderer) | Jest + jsdom + Testing Library | `**/*.test.tsx`                               | jsdom                                            |
| Property-based  | fast-check inside Jest         | `tests/properties/` (and unit files)          | Node                                             |
| Integration     | Jest                           | `tests/integration/`                          | Node (real SQLite from Step 04)                  |
| Scenario        | Jest headless scenario runner  | `tests/scenarios/` (from Step 03)             | Node                                             |
| End-to-end      | Playwright `_electron`         | `tests/e2e/**/*.spec.ts`                      | Real built Electron app, Windows desktop session |

Convention: `*.test.ts` → Node project, `*.test.tsx` → jsdom project, `*.spec.ts` →
Playwright only (Jest never collects it).

## Host preconditions

- **Windows desktop session** for `npm run test:e2e`, `npm run dev`, and packaging checks.
  A headless or non-Windows host cannot verify those; do not claim them from one.
- **`ELECTRON_RUN_AS_NODE`:** terminals spawned by VS Code extensions or other
  Electron-based hosts may export `ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe`
  behave as plain Node (`bad option: --remote-debugging-port=0`, or no window from
  `npm run dev`). The E2E suite strips it from the app's environment. For `npm run dev`,
  unset it first (PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`; bash:
  `unset ELECTRON_RUN_AS_NODE`).
- **Node 24.22+ and npm 12.2+** (`engines`). npm 12 is required for the `allowScripts`
  install-script policy; Node 24 bundles npm 11, so CI installs npm 12 explicitly.
- No Visual Studio build tools are needed: better-sqlite3 13 ships Node-API prebuilds
  and its source-build script is denied in `allowScripts` (DECISIONS ADR-0005, ADR-0011).
- Packaging (`npm run pack` / `npm run dist`) downloads the Electron zip on first run and
  needs network access at build time only. The app itself needs no network.

## Specification scenarios S01–S10 (spec §14.2)

| ID  | Scenario                 | First possible step    | Status      |
| --- | ------------------------ | ---------------------- | ----------- |
| S01 | Empty garage             | 07–08                  | Not started |
| S02 | First production         | 17                     | Not started |
| S03 | Improper fit             | 08                     | Not started |
| S04 | Manager behavior         | 22                     | Not started |
| S05 | Broken machine           | 27                     | Not started |
| S06 | Demand and competitor    | 20–21                  | Not started |
| S07 | Multi-site business      | 26                     | Not started |
| S08 | Save/load                | 04 (kernel), 34 (full) | Not started |
| S09 | Desktop UI               | 06                     | Not started |
| S10 | Fast-forward determinism | 03                     | Not started |

## Step 01 tests

| Test file                                 | What it proves                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tests/unit/shared/bigint-codec.test.ts`  | bigint ↔ canonical decimal string round-trips (fast-check), one encoding per value, malformed text rejected |
| `tests/unit/main/window-security.test.ts` | Renderer windows are context-isolated, sandboxed, no Node integration, web security on                      |
| `tests/unit/renderer/App.test.tsx`        | Shell renders, says no simulation exists, shows bridge data or its absence                                  |
| `tests/e2e/app-shell.spec.ts`             | Real app launches; preload bridge works and is frozen; renderer has no `require`/`process`; one window      |

## Verification log

### 2026-11-07 — Step 01, Windows 11 Pro 10.0.26300, Node 22.14.0, npm 11.3.0

Run in a fresh `git clone` of the Step 01 tree (cloned with `core.autocrlf=true`), not in
the working copy where the files were written.

| Command                                      | Result                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm ci`                                     | Pass; Husky hook installed; postinstall native step completes                    |
| `npm run check`                              | Pass: typecheck (3 programs), lint, format check, Jest 3 suites / 20 tests       |
| `npm run check:deps` (knip)                  | Pass                                                                             |
| `npm run test:e2e`                           | Pass: build, then 3/3 Playwright tests against the real Electron app             |
| `npx electron-builder --dir --publish never` | Pass: `release/win-unpacked/FreeIndustry.exe`, `*.node` unpacked from ASAR       |
| Pre-commit hook                              | Pass: staging a badly formatted file and committing ran lint-staged and fixed it |

Also checked in the working copy:

| Check                                     | Result                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged `FreeIndustry.exe` launch        | Window opens; `app.isPackaged === true`; shell shows Electron 45.2.3 / Node 24.22.2                                                             |
| Built app renderer console                | No errors (after removing meta-ignored `frame-ancestors`, ADR-0008)                                                                             |
| `npm run dev`                             | Window opens, HMR connects, no CSP violations (after dev-only style fix, ADR-0008)                                                              |
| Lint rule probes                          | Forbidden layer import, forbidden package, Node built-in, import cycle, `Math.random`, `Date.now` each reported; `./events` not falsely flagged |
| better-sqlite3 in Node 22 and Electron 45 | Same binary opens `:memory:` in both, SQLite 3.53.4 (ADR-0005)                                                                                  |

### 2026-11-07 — Toolchain upgrade (ADR-0011), Windows 11 Pro 10.0.26300, Node 24.22.1, npm 12.2.2

Fresh `git clone` (with `core.autocrlf=true`) after moving to TypeScript 7, ESLint 10,
eslint-plugin-jsx-a11y-x, lint-staged 17, Node 24 and npm 12.

| Command                                      | Result                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm ci`                                     | Pass; no unreviewed install scripts (`npm approve-scripts --allow-scripts-pending`)  |
| `npm run check`                              | Pass: TS 7 typecheck (3 programs), ESLint 10, format check, Jest 3 suites / 20 tests |
| `npm run check:deps` (knip)                  | Pass                                                                                 |
| `npm run test:e2e`                           | Pass: build, then 3/3 Playwright tests against the real Electron app                 |
| `npx electron-builder --dir --publish never` | Pass; `win32-x64.node` unpacked from ASAR                                            |
| Pre-commit hook (lint-staged 17.6.0)         | Pass: fixed a badly formatted staged file during commit                              |
| Lint rule probes (ESLint 10)                 | a11y, hooks, cycle, boundary, `Math.random`, `Date.now` each reported once           |
| TS 7 error probes                            | Type mismatch and `noUncheckedIndexedAccess` violation both reported                 |
| better-sqlite3 under Node 24.22.1            | Opens `:memory:`, SQLite 3.53.4                                                      |

Not re-run after the upgrade: `npm run dev` (renderer build and E2E launch exercised the same
Vite pipeline).
