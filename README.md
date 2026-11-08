# FreeIndustry

An original, offline, single-player Windows industrial and business simulation. Found a
manufacturing company, lease real premises, lay out machines, hire named staff, buy
materials, make real goods and sell them in a simulated market — managed through classic
movable windows over a living factory floor.

FreeIndustry is inspired by _Free Enterprise_ (1996, Tsunami Media, Inc.). It is an
independent project, not affiliated with or endorsed by the original's creators, and
contains none of the original's code, art, sound or text.

> **Status:** early development. The repository foundation (Step 01 of
> [docs/plan.md](docs/plan.md)) is in place; there is no playable simulation yet.

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

## Development commands

| Command                   | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `npm run dev`             | Run with hot reload                                |
| `npm run check`           | Typecheck, lint, format check and unit tests       |
| `npm test -- --runInBand` | Unit, property and component tests (Jest)          |
| `npm run test:e2e`        | Build, then launch the real app under Playwright   |
| `npm run check:deps`      | Find unused files, exports and dependencies (knip) |
| `npm run pack`            | Unpacked Windows build in `release/win-unpacked`   |
| `npm run dist`            | Windows NSIS installer in `release/`               |

## Documentation

- [Technical specification](docs/TechnicalDocument.md)
- [Development plan](docs/plan.md)
- [Decision record](docs/DECISIONS.md)
- [Original reference ledger](docs/original-reference-ledger.md)
- [Test scenarios and verification log](docs/TEST_SCENARIOS.md)

## License

[Apache License 2.0](LICENSE). The final distribution license is reviewed before release
(plan Step 35).
