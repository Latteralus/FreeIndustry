# FreeIndustry — engineering rules for coding agents

FreeIndustry is an original, offline, single-player Windows industrial/business
simulation inspired by _Free Enterprise_ (1996). Electron + TypeScript + React + PixiJS +
SQLite (`better-sqlite3`).

## Authorities

- Requirements: [docs/TechnicalDocument.md](docs/TechnicalDocument.md) (the technical
  specification).
- Build order and acceptance gates: [docs/plan.md](docs/plan.md). Work on **one numbered
  step at a time**. When its acceptance gate passes, tick **Step accepted** yourself
  (plan.md rule 4), then stop and hand off; do not start the next step unasked.
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Fidelity claims:
  [docs/original-reference-ledger.md](docs/original-reference-ledger.md). Test record:
  [docs/TEST_SCENARIOS.md](docs/TEST_SCENARIOS.md).

## Project engineering rules

- Treat docs/TechnicalDocument.md as the requirements authority.
- Preserve Free Enterprise's sober 1990s factory/business management feel.
- Do not replace real simulation logic with visual-only approximations.
- Keep Electron/React/PixiJS out of src/domain and src/simulation.
- Never let renderer code write SQLite or mutate authoritative world state.
- All money uses integer cents; physical quantities use explicit fixed units.
- All randomness is seeded, deterministic, and persisted.
- Add tests for every domain rule and regression for every bug.
- Do not invent historical original-game rules; update original-reference-ledger.md.
- Do not change architecture, data invariants, or dependencies silently.
- Before declaring work complete: typecheck, lint, format-check, test relevant
  suites, validate content, and report what was actually run.
- Never say a feature is complete when its UI is present but its underlying
  physical/business state transition is not implemented.
- No arbitrary visual effects or UI redesign away from movable-window desktop UI.
- No copyrighted original code, art, sound, or text in this repository.
- Factory views are **true top-down only** (spec D11, DECISIONS ADR-0044): one 2D
  orthographic projection straight down in every mode (layout, operating, inspection). No
  isometric, oblique, three-quarter or perspective view; the camera pans and zooms, never
  tilts or rotates; all art is drawn for the overhead view at real proportions, fitted to
  the object's physical footprint.
- Physical coordinates and dimensions are integer millimetres, areas `bigint` mm²
  (ADR-0045). The construction grid is always 500 mm; placements sit on a 250 mm lattice in
  quarter turns. Never treat pixels, sprite sizes or tile counts as measurements, and never
  derive area from cell counts.
- Structure (geometry, slab load), floor coverings (one material per eligible cell) and
  placed objects are separate state (ADR-0046). Changing one never changes another, and
  floor purchases go through the books like any other expenditure.

## Layout and boundaries

```text
src/main         Electron main: windows, lifecycle, IPC broker. No business logic, no SQLite.
src/preload      Sandboxed, CommonJS; exposes a narrow frozen bridge on window.freeIndustry.
src/worker       Simulation host thread; sole SQLite writer (saves, recovery log).
src/domain       Pure business rules. No Node, Electron, React, PixiJS or SQL.
src/simulation   Event queue, clock, tasks, market. Pure; depends on domain + shared.
src/persistence  SQLite schema, migrations, repositories.
src/catalog      Data-driven content loading and validation.
src/renderer     React desktop shell + PixiJS scenes. Imports only src/shared.
src/shared       IPC DTOs, codecs and read models usable by every layer.
```

These boundaries are **lint errors**, not conventions (DECISIONS ADR-0004). `Math.random`,
`Date.now`, `performance.now` and `new Date()` are banned in domain/simulation/catalog/shared.

## Commands

```bash
npm run dev            # electron-vite dev (unset ELECTRON_RUN_AS_NODE first if set)
npm run typecheck      # TypeScript 7: node, web and test programs separately
npm run lint
npm run format:check
npm test -- --runInBand
npm run test:e2e       # builds, then Playwright launches the real Electron app
npm run check          # typecheck + lint + format:check + check:content + unit tests
npm run check:content  # validate the bundled content pack (content/)
npm run check:deps     # knip: unused files, exports, dependencies
npm run pack           # unpacked Windows build in release/win-unpacked
npm run dist           # NSIS installer
```

## Conventions

- Toolchain: Node 24 LTS, npm 12. `tsc` in node_modules/.bin is TypeScript 6 (the API that
  typescript-eslint and ts-jest need); type-checking uses TypeScript 7 via `npm run tsc7`
  (DECISIONS ADR-0011).
- npm 12 blocks dependency install scripts unless `package.json` `allowScripts` allows them;
  review any new entry with `npm approve-scripts --allow-scripts-pending`.
- Tests: `*.test.ts` run in Node, `*.test.tsx` in jsdom, `*.spec.ts` are Playwright E2E.
- Imports are extension-less; `import type` for type-only imports.
- `bigint` crosses JSON boundaries as canonical decimal strings via
  `src/shared/bigint-codec.ts`.
- Pinned exact dependency versions; record any version change in DECISIONS.md.
