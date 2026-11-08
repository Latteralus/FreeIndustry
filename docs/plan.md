# FreeIndustry — Development Plan

**Document type:** Executable implementation roadmap for a human project owner and AI coding agent  
**Target:** FreeIndustry 1.0 — an original, offline, single-player Windows industrial/business simulation  
**Reference:** `docs/TechnicalDocument.md`  
**Technical stack:** Electron · TypeScript · React · PixiJS · SQLite (`better-sqlite3`)  
**Status:** Living checklist. Steps are ordered by dependency, not calendar dates.

> **Mandate:** Reproduce the mechanically faithful, sober, windowed business-management experience of _Free Enterprise_ (1996) using original code, art, text, and branding. Build a real simulation, not an animated façade. Every piece of material is accounted for from receiving to dispatch; workers are named people performing actual work; the marketplace has financially and physically bounded participants. No decorative spectacle or artificial progression gates.

## How to use this plan with an AI coding agent

1. Work on **one numbered step at a time**, in order. Give the agent the step and the full technical specification. An agent may implement supporting prerequisites but must not silently skip or claim later steps.
2. Before editing, inspect the repository and identify what already exists. Preserve functioning work. If the plan or specification conflicts with existing code, present the conflict and record an approved decision in `docs/DECISIONS.md`.
3. For each step, implement the production behavior, the UI/IPC integration **where applicable**, persisted state **where applicable**, automated tests, and a hands-on demonstration. Stubbed or disabled future functionality must be clearly identified; it cannot masquerade as a working feature.
4. A step is not complete until its **Acceptance gate** passes. Run the relevant commands, record actual results, and check off that step's gate. Never invent test results or mark unimplemented work complete.
5. Keep project reference files current: `docs/TechnicalDocument.md`, `docs/DECISIONS.md`, `docs/original-reference-ledger.md`, `docs/TEST_SCENARIOS.md`, and `docs/plan.md`. Add architecture decision records when the design changes materially.
6. Present a concise handoff after each step: files changed, meaningful behaviors, tests run/pass/fail, remaining limitations, and the exact next step. Stop for project-owner review rather than autonomously implementing the next numbered step.
7. If a step becomes too large for one agent assignment, split it into `Step NN.a`, `Step NN.b`, etc., **without relaxing its final acceptance gate**. Keep dependencies explicit.

### Rules that apply to every step

- [ ] Builds and runs locally on Windows; no mandatory account, network service, or cloud dependency.
- [ ] Architecture stays separated: Electron main/preload; React UI; PixiJS scene; pure simulation/domain; SQLite persistence.
- [ ] Rendering never owns money, inventory, workers, machine state, or time. IPC commands are validated and auditable; the renderer cannot write the database directly.
- [ ] Domain money uses integer minor currency units, physical dimensions use integer canonical units, and quantities use explicit units without floating-point inventory drift.
- [ ] Randomness is seeded; replay and pause/speed/render changes cannot alter the result of the same ordered command sequence.
- [ ] No materials created, destroyed, duplicated, moved, processed, or shipped without a recorded, valid operation. Physical stock can be individually serialized or stored in **exactly counted**, inspectable containers/lots.
- [ ] No employee working invisibly, absent, off shift, in two places, or on two overlapping tasks. No manager authority beyond the player's policy.
- [ ] Every newly introduced invariant has a test; every discovered regression gets a test before or alongside its fix.
- [ ] No copyrighted source code, art, sound, screenshots, dialog, or other assets copied from the original game. Reference research is recorded and categorized as verified, reconstructed, or extended.
- [ ] Preserve the classic movable-window interface and functional density. Avoid modern mobile-style panels, gratuitous visual effects, and abstract resource animations.

### Project-wide verification commands

Use the scripts provided by the repository, generally:

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm test -- --runInBand
npm run test:e2e
npm run build
npm run dist
```

Run only commands supported by the current repository. If a command is missing, create/configure it in the appropriate setup step. Tests requiring the Windows desktop or packaged build must run in a Windows-capable environment; don't claim success from an incompatible host.

---

# Phase A — Repository and simulation foundation

## Step 01 — Establish the repository, standards, and tooling

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [x] Initialize the TypeScript project and source structure from the technical specification; preserve the project name `freeindustry` and desktop product name `FreeIndustry`.
- [x] Install/configure Electron, electron-vite/Vite, React, PixiJS, `better-sqlite3`, TypeScript, Zod, and the Electron builder.
- [x] Configure Prettier, ESLint flat config, Jest + ts-jest, React Testing Library, `fast-check`, Playwright, Husky, lint-staged, and consistent npm scripts; pin tested versions via lockfile.
- [x] Create `.gitignore`, `.editorconfig`, TypeScript configs for separate processes, repository-level code-quality configs, and a Windows CI workflow.
- [x] Add `CLAUDE.md`, `docs/TechnicalDocument.md`, `docs/DECISIONS.md`, `docs/original-reference-ledger.md`, and `docs/TEST_SCENARIOS.md`; maintain clean module boundaries.

**Acceptance gate:** A clean checkout installs, typechecks, lints, formats, executes a sample Jest test, builds, and runs a sample Electron shell. Document any host-specific packaging preconditions. Do not treat dependency installation alone as completion.

**Gate verification (2026-11-07, Windows 11, Node 22.14.0):** passed in a fresh `git clone` of the Step 01 tree: `npm ci`, `npm run check` (typecheck, lint, format check, Jest 20/20), `npm run check:deps`, `npm run test:e2e` (build + 3/3 real-app Playwright tests) and `electron-builder --dir` all succeeded. Host preconditions are in `docs/TEST_SCENARIOS.md`. The CI workflow exists but has not run on GitHub yet (nothing pushed). Re-verified the same way after the toolchain upgrade to TypeScript 7, ESLint 10, Node 24.22.1 and npm 12.2.2 (DECISIONS ADR-0011). Awaiting owner review before ticking **Step accepted**.

## Step 02 — Secure Electron application and typed IPC

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Create main, preload, renderer, and simulation-worker entry points; display a local app window without remote content.
- [ ] Apply context isolation, disabled renderer Node integration, restricted CSP, safe window handling, and a narrow `contextBridge` API.
- [ ] Define typed, Zod-validated request/response/error schemas; attach command IDs and world revisions; reject malformed, unauthorized, duplicated, and stale requests.
- [ ] Implement worker lifecycle, graceful stop, error reporting, and structured local logs. No database handles or arbitrary file paths reach the renderer.

**Acceptance gate:** The app launches and React communicates with a worker through validated IPC. Security settings are asserted in tests; invalid requests do not mutate state; worker failure produces a recoverable error rather than silent data loss.

## Step 03 — Deterministic simulation kernel

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Create pure domain types, entity IDs, world state, command handlers, domain events, and revision checks.
- [ ] Implement a seeded RNG, stable event ordering, discrete simulation clock, priority queue, pause/resume, stepped advance, and adjustable simulation speed.
- [ ] Separate high-frequency physical work from lower-frequency economic/manager decisions; no calculations depend on FPS, wall-clock jitter, or React renders.
- [ ] Add command/event journal, deterministic state fingerprints, and a headless scenario runner.

**Acceptance gate:** Identical seed + starting state + ordered commands yields the same hashes. Different frame rates and pause/speed patterns yield identical domain outcomes. Unit tests run without Electron or PixiJS.

## Step 04 — SQLite persistence, migrations, and recoverable saves

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Define migration framework, foreign keys, transaction discipline, stable IDs, metadata/content versions, and database integrity checks.
- [ ] Persist world configuration, entities, commands/events, RNG state, event queue, audit history, and per-save workspace settings.
- [ ] Implement save slots, atomic checkpoints, load, backup/export/import, and schema-upgrade tests. Keep authoritative SQLite access on the privileged side of IPC.
- [ ] Establish a snapshot-plus-event-log policy, durability/recovery behavior, and prevention of concurrent-write corruption.

**Acceptance gate:** Save during a pending event, shut down, reopen, and resume with the same domain hash as an uninterrupted run. Failed writes roll back cleanly; old fixture saves migrate or fail with a clear compatibility message.

## Step 05 — Company identity, cash accounting, and initial capital

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Model company identity, president/owner, starting settings, accounts, opening balances, and a chart of accounts.
- [ ] Build balanced double-entry postings with integer cents, immutable audit records, cash/credit validation, and transaction references.
- [ ] Support basic payments, charges, rent/deposit obligations, invoices, and receivables/payables as domain events; postpone advanced banking to its dedicated step.
- [ ] Implement an internal account inspection read model to validate journal state before introducing polished reports.

**Acceptance gate:** All postings balance; transactions are idempotent; insolvency/insufficient-funds handling is explicit; opening company funds and expenses survive save/load without unexplained adjustments.

# Phase B — Authentic desktop and city/factory space

## Step 06 — Classic movable-window management desktop

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Construct a restrained 1990s-style menu, toolbar, status bar, and persistent main workspace with a factory viewport background.
- [ ] Implement independent draggable/resizable/overlapping windows with focus/stack order, minimize/maximize, close/reopen, tiling/cascade, keyboard affordances, and sensible minimum sizes.
- [ ] Create reusable compact table, tab, dialog, inspector, dropdown, and error/notification components; keep UI scale configurable.
- [ ] Persist window bounds, tabs, z-order, and filters per save/profile. Keep every command connected through typed IPC.

**Acceptance gate:** Several management windows remain interactive while the factory viewport is visible; moving windows cannot affect simulation outcomes. Closing/reopening and loading restores their layout. No fake production UI is represented as functional.

## Step 07 — World creation, cities, and industrial cityscape

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement **New Company**, **Quick Start**, **Load**, **Scenarios**, **Options**, **Help**, **Exit**.
- [ ] Create data-driven cities/districts with rents, labor availability, transport access, buyers, suppliers, and rival-business starting conditions.
- [ ] Render a selectable, old-school industrial cityscape with individual buildings, occupied/vacant properties, tooltips, and property inspection.
- [ ] Support realistic garage, workshop, industrial unit, warehouse, and factory properties with real dimensions, access, price, and tenancy terms. Company starts without machinery, labor, or stock.

**Acceptance gate:** Player can examine different locations, select/lease a real property using available funds, and transition to its initially empty interior. Different properties have genuinely different costs, dimensions, and usable conditions—not just labels.

## Step 08 — Authoritative facility geometry and equipment placement

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Model parcel/interior polygons, walls, columns, doors, docks, power/utility connections, levels, forbidden zones, and usable floor area.
- [ ] Use canonical integer millimeters and a consistent world-to-pixel transform; provide the specified 500-mm construction grid.
- [ ] Implement factory layout mode with pan/zoom, rotation, bounds/collision checks, clearance envelopes, walkways, access zones, and placement previews.
- [ ] Define equipment footprint/cost/utility/port data; purchasing equipment creates owned equipment that must be installed before use.

**Acceptance gate:** A tiny garage renders tiny relative to a large warehouse; floor area derives from geometry, not viewport size. An oversized machine or blocked route cannot be placed. Every placement and expenditure persists exactly.

## Step 09 — PixiJS factory renderer and observation mode

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement rendering projections from authoritative domain state, selection/inspection synchronization, stable sprite IDs, camera transforms, and texture management.
- [ ] Provide top-down layout mode and an old-school oblique/three-quarter operating mode derived from the **same physical coordinates**.
- [ ] Render facilities, machines, doors, storage zones, docks, and placeholder original industrial sprites (newly authored, not copied from the original).
- [ ] Establish scene diff updates, sprite pooling, zoom behavior, UI overlays, and minimal operational state indicators.

**Acceptance gate:** A machine appears at its actual real-world location in both display modes; both views select the same machine entity. Switching or closing views never changes the world hash. Rendering is functional and deliberately understated.

# Phase C — Tangible manufacturing vertical slice

## Step 10 — Physical stock, lots, load units, and conservation

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Define products, units, dimensions, weight, quality, serialized goods, counted lots, ownership, locations, genealogy, and quantity reservations.
- [ ] Introduce containers/pallets/stacks/carts/machine buffers with capacity, exact counted contents, physical coordinates, and inspectable histories.
- [ ] Implement atomic transfers, split/merge constraints, origin tracking, stock-taking, loss/scrap classification, and negative-stock prevention.
- [ ] Render the real location of each on-premises stock unit; aggregate bulk quantities visually only inside a countable, inspectable physical container.

**Acceptance gate:** Stock cannot materialize between locations or be assigned to two containers. Quantity and mass/unit-conversion invariants pass property-based tests; the player can click a container and see its contents and provenance.

## Step 11 — Named people, employment, attendance, and schedules

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Model unique named candidates/employees, skills, aptitude, wages, salary classifications, roles, managers, schedules, attendance, morale, fatigue, certifications, and employment history.
- [ ] Implement recruiting, offers, hiring, assigning workplaces, resignations/termination, and basic payroll accruals backed by accounting entries.
- [ ] Create employee records and Personnel windows with assignments, schedules, goals, activity histories, wages, and workplace statuses.
- [ ] Spawn people on site only when physically present and eligible; off-shift and absent employees cannot produce or perform office work.

**Acceptance gate:** Named workers can be hired and assigned, appear on site only when scheduled/present, generate legitimate wages, and retain identity and work history after reload. No two workers share a single task execution identity.

## Step 12 — Task scheduling, navigation, and physical handling

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement explicit task prerequisites, skill/availability checks, priorities, assignment, state transitions, cancellation, and resource reservations.
- [ ] Create pathfinding for workers through actual floor geometry, non-overlap reservations, travel/work durations, and deterministic congestion resolution.
- [ ] Add pickup, carry/cart movement, placement, unloading, and return-to-station activities tied to physical containers and route availability.
- [ ] Render worker location/animation based on the task and actual path, not independent display-only movement.

**Acceptance gate:** A worker walks around obstacles, physically collects and relocates a counted stock container, and records movement history; blocked routes halt the work. No off-duty worker, impossible route, task overlap, or double transfer can occur.

## Step 13 — Machinery, recipes, and real production

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Define data-driven product and machine catalog schemas, recipe graphs, input/output ports, processing requirements, batch sizes, setup/cycle times, labor and utilities.
- [ ] Implement machine states: installed/idle/reserved/loading/setup/processing/unloading/blocked/unpowered, with explicit in/out buffers.
- [ ] Connect operator tasks to real machine operation; consume exact inputs, produce exact output/scrap, and record quality and batch genealogy.
- [ ] Add factory operational inspection windows for a machine, job queue, inputs, outputs, bottlenecks, and worker assignments.

**Acceptance gate:** One real employee processes physically present inputs into valid outputs on an installed machine; no output exists before completion. Missing operators, routes, energy, or required input prevents processing. Recipe conservation tests pass.

## Step 14 — Purchasing, supplier orders, and physical receiving

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Model suppliers, offers/quotes, purchase orders, commitments, lead/transport constraints, and allocated stock.
- [ ] Implement direct player purchasing, freight shipment lifecycle, arrival at real access points, receiving tasks, count verification, storage movement, and invoice posting.
- [ ] Require staff/handling capacity at the dock or receiving door; prevent instant direct-to-machine inventory delivery.
- [ ] Create Purchasing and Receiving windows with orders, shipment status, exceptions, costs, and audit history.

**Acceptance gate:** A purchased lot is represented by an inbound shipment, reaches the property, is physically unloaded and moved to inventory by available staff, and reconciles with money/payables. No arrival can bypass premises access or staff handling.

## Step 15 — Storage, staging, internal material flow, and congestion

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement warehouse/storage zones, racks, stacking/volume/weight limits, operator-access rules, and named staging locations.
- [ ] Support hand-carry, carts, and internal transfer jobs; integrate machine buffers with stock reservations and throughput blocking.
- [ ] Add configurable conveyors/material-handling devices with bounded capacity and actual connections where their catalog capability exists.
- [ ] Expose bottlenecks and blocked flows through diagnostics rather than compensating with teleportation.

**Acceptance gate:** Production stops when buffers/storage are full or material-handling routes are blocked. Moving a machine or storage zone changes physically feasible production paths. Storage never exceeds defined capacity.

## Step 16 — Sales orders, finished goods, and physical dispatch

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Define customer orders, available-to-promise inventory, price, fulfillment, invoicing, shipment reservations, delivery terms, and settlement.
- [ ] Implement player-directed sale of actually produced goods; picking, staging, loading, carrier pickup, departure, and delivered/settled states.
- [ ] Create Sales and Dispatch windows with order lifecycle, shipment contents, shortages, and per-order margins.
- [ ] Ensure a product leaves player-owned stock only through an authorized physical transfer and recorded sale/transfer/loss event.

**Acceptance gate:** A complete order moves from factory output to physical staging/loading and departs through a valid exit. Selling unavailable stock, shipping unpicked units, or receiving duplicate payment is impossible.

## Step 17 — Integrated playable enterprise loop

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Connect city selection → property lease → machine purchase/placement → employee hire/assignment → material purchase/receiving → processing → stock storage → sale → shipment → cash/receivable update.
- [ ] Provide a small but complete original content set (at least one meaningful production chain) and a discoverable workflow through the movable-window interface.
- [ ] Support save/load mid-operation, operating vs layout mode, pause/step/accelerate, and clear explainable errors.
- [ ] Build an end-to-end automated fixture and a human-test walkthrough reproducing this exact flow.

**Acceptance gate:** A fresh install lets a player create a company and profit or lose money through _actual_ production without developer console intervention. Every physical item, labor task, inventory change, and financial posting in the example is explainable and auditable. This is the **first complete playable vertical slice**, not a release declaration.

# Phase D — Business management fidelity and real competition

## Step 18 — Detailed financial controls and reporting

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Complete general ledger, inventory valuation/COGS, payroll, rent, depreciation, taxes/fees as defined in game rules, invoices, cash movements, and period closes.
- [ ] Add original-style statements and detailed company reports: cash flow, income, balance sheet, product margins, production costs, employee costs, and facility performance.
- [ ] Provide sortable, filterable, exportable tables and double-click drilldowns to source transactions.
- [ ] Detect accounting anomalies and keep posted records immutable, correcting via new entries.

**Acceptance gate:** Reports reconcile to the transaction ledger and stock movements; no unbalanced journal exists. Save/reload and alternate UI navigation produce identical figures. Financial reports are practical management tools rather than decorative charts.

## Step 19 — Employee development and operational departments

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement skill growth, training, worker effectiveness, role fit, promotions, fatigue, morale, job satisfaction, turnover, absence, and safe task eligibility.
- [ ] Add office spaces and real office tasks for buyers, salespeople, accountants, researchers, supervisors, and management; these workers occupy assigned facilities/stations when working.
- [ ] Implement shift assignment, department structures, manager reporting chains, work histories, and productivity/attendance reports.
- [ ] Connect staff capacity and skills to achievable operational throughput and error rates; eliminate generic invisible office output.

**Acceptance gate:** Personnel changes cause explainable measured outcomes; office work has defined tasks and capacity. A worker cannot provide the benefits of two incompatible simultaneous jobs, and staff cannot operate from a facility they are not in.

## Step 20 — Market actors, prices, and economically caused demand

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Define persistent buyers, supplier firms, employment markets, product demand, inventory, budgets, costs, and logistics limits.
- [ ] Implement pricing, order matching, contracts/spot transactions, shortages, price response, and transparent economic indicators.
- [ ] Make customer demand respond to price, quality, availability, relationships, and substitution rather than guaranteed sales.
- [ ] Provide city/company/industry market views grounded in actual simulated transactions and observable information.

**Acceptance gate:** Supply shortages, pricing differences, and actual inventory changes produce causal market shifts. No supplier can sell infinite physically unavailable product; no buyer has unlimited cash or demand. Fixed seed tests reproduce the same market history.

## Step 21 — Competing manufacturing businesses

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement rival firms with funding, facilities, staffing or bounded aggregate labor, machinery/production capability, stock, bills, transport, and business decisions.
- [ ] Give rivals the same economic constraints as the player: procurement, capacity, costs, pricing, loans/credit, wages, demand, and possible business failure.
- [ ] Simulate off-screen firms efficiently with physically and financially bounded aggregate operations; never generate free inventory or money for rivals.
- [ ] Populate city buildings and competition reports from actual rivals; allow entry, expansion, contraction, and exit through the economy.

**Acceptance gate:** A rival can go short of materials, suffer a bottleneck, win/lose business, fail, or grow only when causes permit. Rival supply affects prices and player sales. Accounting/stock constraints and deterministic replay pass.

## Step 22 — Original-style purchasing and sales delegation

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement purchasing agents who follow the player's configurable PRICE/QUALITY/VALUE preferences, supplier rules, replenishment targets, and spending authority.
- [ ] Implement sales staff who pursue orders, suggest prices, manage buyer relationships, and execute only approved or delegated commercial decisions.
- [ ] Support supervisors/administrators carrying out accountable tasks, messages, inbox memos, exception queues, and escalation requests.
- [ ] Expose authority, reasoning inputs, decisions, outcomes, and manual override; default to player control if no employee holds the responsibility.

**Acceptance gate:** Hiring and assigning a qualified buyer enables policy-constrained purchasing; dismissing or unassigning them stops new automated purchases. Changing PRICE to QUALITY changes eligible choices under controlled test conditions. No spending exceeds approved authority.

## Step 23 — Contracts and commercial relationships

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Model offers, counteroffers, contract terms, quantities, unit price, quality requirements, delivery windows, penalties, credit terms, and renewals.
- [ ] Integrate negotiated purchasing/sales agreements with market actors, reservations, dispatch, invoices, arrears, disputes, and fulfillment history.
- [ ] Implement approval workflows so sales/purchasing managers may negotiate or sign only within delegated limits.
- [ ] Build Contracts and correspondence windows with clear obligations and alerts, retaining player's direct control.

**Acceptance gate:** A signed agreement creates enforceable simulation obligations; delivery failure or insufficient stock has documented consequences. A manager cannot sign outside authorization. Orders, ledger entries, stock, and contract status reconcile.

## Step 24 — Research, product development, and technology

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Implement research staff, facilities, budgets, projects, skills, equipment requirements, and actual research tasks.
- [ ] Support product and process improvements, machine upgrades, new recipes/technologies, quality, cost, and market-obsolescence effects.
- [ ] Preserve the original game's market-research and product-research philosophy; separate verified original behavior from independent extensions in the ledger.
- [ ] Offer research windows, project choices, information reports, and measurable business tradeoffs.

**Acceptance gate:** Research consumes budget, staff effort, and applicable resources; no research progresses without capacity. Completed technologies change real production/market rules without retroactively altering past stock or financial history.

## Step 25 — Banking, loans, credit, and cash-constrained growth

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Add bank accounts, deposits, loans, interest, payment schedules, credit limits, collateral, and default handling.
- [ ] Support leasing vs buying properties, financing capital expenditure, and transparent facility/equipment carrying costs.
- [ ] Enforce costs, available property, physical fit, labor, and market feasibility instead of progression levels or unlock gates.
- [ ] Build Bank and Real Estate windows matching the original game's practical desktop feel.

**Acceptance gate:** A company can borrow and service debt, run out of liquidity, miss obligations, or grow through financed purchases. Interest and principal reconcile; no purchase can escape affordability/credit checks.

## Step 26 — Multi-site ownership and external logistics

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Support multiple facilities across districts/cities, each with accurate geometry, own floor layout, employees, equipment, utility needs, inventory, and costs.
- [ ] Model carrier capacity, route/distance cost, shipping lead, loading docks, transport vehicles/loads, and inter-facility transfer orders.
- [ ] Implement facility switching and company-wide management reports without losing local physical state.
- [ ] Ensure transfer documents and shipping records preserve exact lot identity/quantity and company-wide accounting.

**Acceptance gate:** A product physically leaves one facility, occupies recorded transport capacity, and arrives for unloading at another. No inter-site teleportation, duplicated WIP, vanished loads, or contradictory site-level statements.

# Phase E — Complete original-style systems and content

## Step 27 — Machine failures, maintenance, utilities, and quality

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Add degradation, maintenance schedules, failures, repair tasks, spare parts, installation constraints, and replacement decisions.
- [ ] Introduce operational utilities and availability (power, water/ventilation when applicable) with realistic capacity/cost effects.
- [ ] Implement quality distributions, defects, rework, scrap, inspections, and warranty/return implications where applicable.
- [ ] Extend machine/worker inspections, alarms, and cost reporting without decorative warnings.

**Acceptance gate:** Breaking a machine preserves exact WIP and reservations; repairs consume valid labor/parts. Quality results flow into real stock grades, customer acceptance, and financial costs. Save/reload during failure is lossless.

## Step 28 — Production planning and complex factory networks

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Add multi-machine bills of materials, intermediate goods, priorities, work orders, queues, staffing policies, shifts, changeovers, and production targets.
- [ ] Extend conveyors, forklifts, buffers, sorters, and warehouse paths for complex facilities with deterministic resource contention.
- [ ] Provide production schedules, bottleneck diagnostics, station utilization, throughput, lead-time, and traceable batch genealogies.
- [ ] Handle deadlock/blocking, unavailable resources, production interruption, and cancellation with reservation recovery.

**Acceptance gate:** A multi-stage chain with alternative machines and shared resources functions correctly; changing capacity or staffing creates explainable bottlenecks. No deadlocks persist without diagnostics/recovery; item/ledger invariants hold under randomized scenarios.

## Step 29 — Broad data-driven industry and product catalog

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Expand original-inspired manufacturing breadth through data-defined goods, components, machinery, labor skills, recipes, and economic sectors; avoid bespoke code for each SKU.
- [ ] Make a coherent set of complete production chains with real suppliers, buyers, market demand, quality tiers, research, and competition—not just an item list.
- [ ] Implement schema validation, catalog linting, stable IDs, content versioning, referential integrity, and build-time catalog checks.
- [ ] Use the original research ledger to track historical mechanics/features included, adapted, still incomplete, or intentionally substituted; do not assert false one-to-one historical fidelity.

**Acceptance gate:** Content coverage supports a varied, long-running manufacturing company and showcases the original's multi-product breadth. Every enabled item is producible or legitimately sourced, storable, transportable, marketable, and financially accounted for. Invalid definitions fail validation.

## Step 30 — Business information, city ecology, and company history

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Complete original-style memos, notifications, consultant/industry information, company rankings, competitor intelligence, and research-dependent visibility.
- [ ] Track persistent histories of firms, workers, products, transactions, buildings, loans, market share, and major decisions.
- [ ] Implement city changes consistent with marketplace outcomes: property vacancies, rents, competitor moves, employment availability, and supplier capacity.
- [ ] Ensure observability through reports and inspectable records while maintaining privacy/visibility boundaries for competitor information.

**Acceptance gate:** World reports derive from saved events and real economic state. Rival expansion, insolvency, market shifts, and company decisions leave discoverable causal history; data is not retroactively fabricated for a report.

## Step 31 — Scenarios, onboarding, options, and accessibility

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Provide original-style new-company setup with configurable capital, city, market conditions, property options, and truly empty or explicitly prebuilt scenarios.
- [ ] Add concise context help, tooltips, searchable documentation, basic tutorials/assistance for operational flows, and informative errors.
- [ ] Complete practical settings: UI scaling, resolution/window options, sound, autosave choice, data location, display units, shortcuts, and accessible status labels.
- [ ] Preserve simple, functional presentation; avoid forced cinematic intro, flashing prompts, reward effects, or modal tutorial interruptions.

**Acceptance gate:** A player unfamiliar with the code can found a company, understand blocked processes, complete production, and discover the relevant personnel/finance controls without developer help. Keyboard navigation and text readability are verified.

# Phase F — Reliability, distribution, and 1.0 acceptance

## Step 32 — Long-run consistency, balancing, and AI behavior audit

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Run seeded headless scenarios covering small garages, established factories, competing markets, shortages, debt distress, expansion, and multi-site logistics.
- [ ] Audit market causality, survival/failure rates, employee behavior, purchasing policies, goods conservation, finances, capacity, and the risk of unbounded growth or resource creation.
- [ ] Tune parameters using documented fixtures and repeatable results rather than hidden dynamic cheats.
- [ ] Create regression tests for each uncovered exploit, pathological loop, double-posting, worker starvation, or economic instability.

**Acceptance gate:** Extended simulations remain internally consistent and exhibit plausible outcomes without free money, free goods, permanent AI deadlocks, or silent state corruption. Balancing outcomes are recorded with seed/fixture and reasons for adjustments.

## Step 33 — Performance, responsiveness, and deterministic stress tests

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Benchmark large facilities, many physically tracked lots, numerous workers, multiple businesses, accelerated simulation, SQLite snapshots, and busy draggable windows.
- [ ] Optimize only measured bottlenecks using spatial indices, chunked queries, event scheduling, worker/path caches, projection diffs, and sprite pooling.
- [ ] Keep the Electron UI responsive; move heavy simulation/DB work off the renderer; cap or backpressure update traffic without changing authoritative results.
- [ ] Add reproducible performance fixtures, resource metrics, diagnostic logging, and explicit hardware/scale notes in test documentation.

**Acceptance gate:** Documented acceptance scenarios run on supported Windows hardware with responsive controls and no unbounded memory/CPU growth. Equivalent slow/fast/render-disabled simulations match final domain hashes. Do not claim unsupported numeric performance results.

## Step 34 — Save compatibility, crash recovery, and full regression suite

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Exercise saves with active machinery, staff movement, freight, pending contracts, loans, payroll, and market decisions; restart mid-operation.
- [ ] Test migration of all supported save formats, rollback/backup recovery, forced-shutdown behavior, corruption detection, and import/export.
- [ ] Expand Jest/fast-check and real-app Playwright suites to cover the specification's S01–S10 scenarios; enforce end-to-end accounting/stock/geometry/security invariants.
- [ ] Add clean-install smoke tests and UI layout persistence tests, including multiwindow operation during running factories.

**Acceptance gate:** Critical systems survive shutdown, restart, and upgrade without state loss or duplicated work. Automated suites pass; known failures are documented and resolved before the next step.

## Step 35 — Credits, licensing, asset audit, and release documentation

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Resolve the open project-license decision before distribution (Apache-2.0 + retained `NOTICE` attribution, or a different deliberately approved license if prominent in-app fork credits are required).
- [ ] Add full license text, third-party notices, dependency and asset provenance, contributor credits, original work attribution, and a non-affiliation statement.
- [ ] Credit **Free Enterprise (1996), developed by Tsunami Media, Inc.**, as FreeIndustry's historical inspiration in the game's About/Credits and project documentation; never imply endorsement.
- [ ] Prepare user-facing README, installation, gameplay reference, configuration, troubleshooting, save-format notes, support boundaries, and changelog. Ensure distribution permissions for every dependency and original asset.

**Acceptance gate:** All distributed code, assets, and licenses are accounted for; legal notices display correctly in the packaged app and files. No unlicensed original-game material is present. License/NOTICE obligations are verified rather than assumed.

## Step 36 — Windows installer and release build validation

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Configure electron-builder, icons, app identity, clean install/uninstall behavior, file associations only where justified, and installation options.
- [ ] Rebuild and package `better-sqlite3` for the Electron ABI; unpack native binaries correctly; verify production filesystem, resources, and database permissions.
- [ ] Test on a fresh Windows environment: install, launch, create company, save, exit, reopen, load, export, and uninstall; verify no network access is needed.
- [ ] Generate versioned release artifacts, checksums, release notes, and a reproducible build procedure.

**Acceptance gate:** Installed `.exe` functions independently of VS Code, npm, dev server, and external services. Native SQLite works in the packaged app, and saves live in a user-writable per-user location rather than the installation directory.

## Step 37 — FreeIndustry 1.0 final acceptance and sign-off

- [ ] **Step accepted:** All implementation tasks and the acceptance gate below are verified.

**Build:**

- [ ] Walk through every original-mechanics entry in the fidelity ledger: mark `IMPLEMENTED`, `RECONSTRUCTED`, `EXTENDED`, or an explicitly approved deviation. Resolve unfinished entries required for 1.0.
- [ ] Re-run all S01–S10 specification scenarios, the full first-company workflow, multi-product/multi-machine operations, management delegation, marketplace/competitor activity, financial reporting, research, credit, property expansion, and multi-site supply flow.
- [ ] Conduct a full interactive usability review of the cityscape, movable windows, simultaneous factory observation, readable reports, controls, and old-school business aesthetic.
- [ ] Triage and resolve release-blocking crashes, save corruption, inventory/money creation, deadlocks, critical navigation failures, misleading output, and legal/packaging defects.
- [ ] Set semantic version to `1.0.0`, tag the release, archive verified artifacts, and finish the release checklist and project documentation.

**Acceptance gate:** Owner signs off that FreeIndustry is a _complete playable industrial business simulation_, not merely a functioning prototype. All required mechanics are meaningfully integrated; no critical known defect violates domain truth; release artifacts install and run; the tested 1.0 source tag corresponds to the shipped executable.

---

# Final 1.0 release gates (all required)

- [ ] **Mechanical fidelity:** Research ledger demonstrates coverage of documented _Free Enterprise_ systems, with transparent distinctions between faithful recreation and new extensions.
- [ ] **Physical truth:** Inbound materials → receiving → internal transfer → machinery → WIP → storage → loading → dispatch can be followed by identity, location, quantity, worker/task, and ledger.
- [ ] **Human truth:** Named employees have wages, skills, shifts, goals, tasks, physical presence, progression, supervisors, and auditable work histories; managers obey delegated powers.
- [ ] **Economic truth:** Suppliers, buyers, competitors, prices, credit, labor, demand, and contracts are causally modeled and resource-bounded.
- [ ] **Space truth:** Tiny properties and expansive factories have consistent real-world geometry, machine fit, routes, storage, and utility constraints.
- [ ] **Presentation truth:** A cityscape and the original-inspired movable-window business desktop coexist with a living, inspectable factory in layout and operating views.
- [ ] **Engineering truth:** Deterministic tests, financial/stock invariants, migration tests, scenario tests, and Windows E2E packaging tests pass and can be reproduced.
- [ ] **Ownership truth:** Original assets/code, third-party obligations, and acknowledgment of the historic game are accounted for under a deliberately selected license.
- [ ] **Player truth:** From a fresh install, a player can establish a tiny business and expand toward multiple warehouses and factories through money, financing, physical resources, and a real marketplace—with no artificial level gates.

## Agent prompt template

Copy into your coding agent, substituting the desired step number:

```text
Implement Step NN from docs/plan.md for FreeIndustry.

First read docs/plan.md, docs/TechnicalDocument.md, CLAUDE.md,
and the current code. Work on Step NN only. Preserve the agreed
Electron + React + PixiJS + TypeScript + SQLite architecture and the
original-style movable-window UI. No fake inventory, fake staff work,
noncausal market events, or animation-only behaviors.

Implement the code, integration, tests, persistence and documentation
required by the step. Run the relevant validation commands and report
the actual results. Do not mark the step complete unless every
Acceptance gate condition passes. If blocked, state the blocker and
leave the checkbox incomplete. Record material technical choices in
docs/DECISIONS.md and original-game fidelity claims in the reference
ledger. Stop after this step and report the next step number.
```

**End of plan.md**
