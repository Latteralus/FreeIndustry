# FreeIndustry

**An offline, single-player industrial and business simulation for Windows.** Found a
manufacturing company, lease real premises, lay out machines, hire named people, buy
materials, make real goods and sell them in a simulated market. You run all of it from
classic movable windows laid over a living factory floor.

> **Status:** early development. The secure desktop shell, the deterministic simulation
> kernel (seeded randomness, an event queue, a pausable clock with speeds and targeted
> advances, a command/event journal and state fingerprints) and SQLite saves (save slots,
> autosaves, export/import, format upgrades and crash recovery) are in place, and a company
> can be founded with double-entry books: opening capital, bills, payments, rent and deposit
> schedules (Steps 01–05 of the [development plan](docs/plan.md)). There is no property,
> staff or factory yet, so there is still nothing to play.

## Inspired by _Free Enterprise_ (1996)

FreeIndustry is inspired by **_Free Enterprise_**, a Windows business simulation released in
1996 by Tsunami Media, Inc. In it you picked an American city and a building, laid out a
factory floor, hired workers into specific roles, set purchasing guidelines and sale prices,
researched new products, borrowed from the bank and competed with rival firms. Then you
watched your plant run in an angled operating view, with workers moving and goods flowing
between machines.

Few games since have treated manufacturing as a _business_: a place of people, cash,
suppliers and customers rather than conveyor puzzles. Yet the original is hard to run today
and had real limits: operating turns you could not stop, a single fixed factory, and thin
documentation. FreeIndustry aims to carry its spirit forward as a new game built from
scratch.

**FreeIndustry is an independent project.** It is not affiliated with or endorsed by Tsunami
Media or anyone connected with _Free Enterprise_. It contains none of the original's code,
art, sound, music or text. What we know about the original comes from public reviews and
walkthroughs, and the [original reference ledger](docs/original-reference-ledger.md) keeps
documented original behaviour separate from our own reconstructions and extensions.

## The vision

Picture sitting back, watching a busy factory, and understanding exactly what every person
and every crate on the floor is doing. You run the company through overlapping 1990s-style
management windows while production carries on behind them. That is the goal, built on a
few rules we don't bend:

- **Every product exists.** Raw materials, work in progress and finished goods have a
  quantity, an owner and a physical place: a pallet, a shelf, a machine, a truck. Nothing
  appears, moves or ships without a recorded operation, and a lot can be traced from its
  supplier to its customer.
- **Every employee is a person.** Staff are named individuals with skills, wages, shifts and
  a work history. They only work when they are actually on site, and office work is real
  work with real effects.
- **The building is real.** Premises have true dimensions. A small garage really is small,
  and a machine that doesn't fit can't be placed.
- **The market has causes.** Suppliers, customers and rival firms have finite stock, money
  and capacity. Prices come from real offers and real demand, and rivals produce from real
  inputs, not scripted numbers.
- **Money and physics are the only limits.** There are no levels and no unlock gates. You
  grow by having the funds or the credit, the space, the staff and a market for what you
  make, from a single garage towards several warehouses and factories.
- **You are in charge, and you can delegate.** You set prices, purchasing policies (_price_,
  _quality_ or _value_), staffing and investments yourself, or hand them to named staff
  within limits you choose. Every delegated decision can be seen and reversed.
- **Sober, information-dense presentation.** A menubar, toolbar, status bar, compact tables
  and draggable windows, with the factory always visible behind them. No confetti, no
  cinematic effects, no mobile-style dashboards.
- **Deterministic and fair.** The same seed and the same decisions always produce the same
  company. Pausing, speeding up or looking away never changes the outcome.
- **Yours, offline.** No account, no network, no telemetry, no microtransactions. Saves are
  local files you can export and keep.

Where the original was limited, FreeIndustry improves rather than copies it. Time is
continuous and can be paused, stepped or fast-forwarded to the end of the day or the next
event, and a company can expand to several sites. Each feature is labelled in the ledger as
faithful, reconstructed or new.

## Requirements

- Windows 10 or 11
- Node.js 24 LTS (`.nvmrc`; 24.22 or newer) and npm 12.2 or newer

No Visual Studio build tools are required.

## Getting started

```bash
npm ci
npm run dev
```

If `npm run dev` builds but no window appears, your terminal may have
`ELECTRON_RUN_AS_NODE` set (VS Code extension terminals sometimes do). Unset it and retry:
PowerShell `Remove-Item Env:ELECTRON_RUN_AS_NODE`, bash `unset ELECTRON_RUN_AS_NODE`.

Logs are written locally to `%APPDATA%\FreeIndustry\logs\freeindustry.log` (JSON lines,
rotated by size) and are never uploaded. Saves live in `%APPDATA%\FreeIndustry\saves\`: one
`.fisave` SQLite file per save, with copies made before a format upgrade in `backups\`. The
running session's crash-recovery log is in `%APPDATA%\FreeIndustry\recovery\`.

## Built with

Electron, TypeScript, React, PixiJS and SQLite (`better-sqlite3`). The simulation runs in its
own worker thread, separate from rendering, and is tested with Jest, fast-check and
Playwright.

## Development commands

| Command                   | Purpose                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `npm run dev`             | Run with hot reload                                              |
| `npm run check`           | Typecheck, lint, format check, content validation and unit tests |
| `npm run check:content`   | Validate the bundled content (cities, property, scenarios)       |
| `npm test -- --runInBand` | Unit, property and component tests (Jest)                        |
| `npm run test:e2e`        | Build, then launch the real app under Playwright                 |
| `npm run check:deps`      | Find unused files, exports and dependencies (knip)               |
| `npm run pack`            | Unpacked Windows build in `release/win-unpacked`                 |
| `npm run dist`            | Windows NSIS installer in `release/`                             |

## Documentation

- [Technical specification](docs/TechnicalDocument.md): requirements and design laws
- [Development plan](docs/plan.md): the 37-step roadmap to 1.0 and each step's acceptance gate
- [Decision record](docs/DECISIONS.md)
- [Original reference ledger](docs/original-reference-ledger.md): what the 1996 game did,
  and how sure we are
- [Test scenarios and verification log](docs/TEST_SCENARIOS.md)

## License

[Apache License 2.0](LICENSE). The final distribution license is reviewed before release
(plan Step 35). _Free Enterprise_ and its names belong to their respective owners and are
mentioned here only to credit the game that inspired this one.
