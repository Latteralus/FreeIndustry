# Industrial Business Simulation "FreeIndustry"
## Technical Architecture & Gameplay Systems Specification

**Project designation:** Independent modern spiritual successor to *Free Enterpri$e / Free Enterprise* (Tsunami Media, 1996)  
**Document status:** Architecture and requirements baseline  
**Target platform:** Windows desktop, offline single-player  
**Primary stack:** Electron + TypeScript + PixiJS + React + SQLite  
**Development audience:** Human project owner and AI coding agents working in VS Code

> **Project mandate:** Reproduce the **mechanical character and desktop workflow** of the original *Free Enterprise* as faithfully as practical, with fully original code, art, sound, text, and branding. Modernization should remove technical limits and deepen simulation, **not** replace the original's sober, information-dense 1990s industrial-business identity with flashy game UI. This is a business simulation first.

> **Scope discipline:** This specification intentionally contains **no development timelines or release schedule**. Implementation order may follow dependencies, but estimates and deadlines are excluded.

---

## 1. Product identity and non-negotiable principles

### 1.1 Player fantasy

The player establishes and operates a manufacturing company in an economically active city. They evaluate markets, lease or acquire property, lay out a factory, purchase machines, recruit individually simulated staff, procure raw materials, manufacture actual items, and sell them to simulated buyers. As the business grows, the player can expand to multiple buildings, warehouses, and factories, and delegate operational decisions to named employees.

The experience should feel like operating a real enterprise from a Windows-era management application that happens to show a living factory. The player is not asked to click periodically to generate money. Profit results from physical production and actual market transactions.

### 1.2 Design laws

**D01 — Fidelity of function.** Recreate verified original mechanics and workflows wherever practicable. Preserve city selection, real estate selection, machine and office placement, worker roles, individual attributes, memos/inbox, products and research, purchasing/sales administration, bank functions, detailed reports, and planning/observing production. If a mechanic is undocumented, label the implementation a reconstruction rather than asserting it is original.

**D02 — Every product exists.** Every inbound raw material, work-in-progress item, component, and finished good has a state, ownership, quantity, and physical location (including containers, vehicles, machines, or inventory zones). It must not appear, move, transform, or depart without an authorized state transition and physical/logistical operation.

**D03 — Every employee is a person.** Every hired employee has a persistent identity, role, wage, capabilities, schedule, assigned goals/tasks, state, activity log, and workplace location whenever on premises. No off-screen productivity from people who are absent or unable to work. Office work is real work; its effects propagate into procurement, accounting, sales, research, and management.

**D04 — Market causality.** Rivals, suppliers, buyers, logistics capacity, costs, demand, and prices have modeled causes. Competitors produce from resources and capacity, not unbounded scripted stock. Aggregate simulation is acceptable for off-screen sites, provided balance and capacity constraints are upheld.

**D05 — The building is real.** Facility dimensions, rentable area, loading access, obstructions, and permitted usable floor area are authoritative. A tiny garage must occupy a tiny floor in the rendering; no scaling a 50 sq ft interior to look like a 10,000 sq ft factory.

**D06 — Old-school presentation.** Traditional menubar and toolbar, draggable and resizable floating management windows, compact tables, readable small text, status bar, subdued colors, visual manufacturing activity behind open windows. No decorative particles, dramatic cinematic effects, oversized cards, gamified progress confetti, or forced modern dashboards.

**D07 — Player authority with optional delegation.** The player can directly control purchasing guidelines, prices, staffing, assignments, equipment, contracts, investments, and financial decisions. Named staff may automate only decisions within their assigned authority. Delegation must be transparent, reversible, and auditable.

**D08 — Money and physical feasibility are the constraints.** No artificial levels, arbitrary building unlocks, or paywall progression. Growth depends on available funds or financing, land/building availability, physical space, machine supply, staff, market conditions, and achievable research and production capabilities.

**D09 — Deterministic and testable.** Given seed, starting snapshot, content version, and ordered player commands, the simulation yields the same business and inventory outcomes. Presentation frames do not influence business results.

**D10 — Offline, local, and ownable.** No required account, cloud services, telemetry, advertising, microtransactions, or network connection. Saves are local, exportable, and versioned. Original IP is not included.

### 1.3 Explicit exclusions

- No multiplayer or networking requirement.
- No browser-hosted game; Electron packages a local desktop application.
- No forced campaign victory condition; scenarios or challenges may exist, but open-ended operation is core.
- No cinematic graphics at the expense of readability or simulation.
- No copying the 1996 game's source code, binaries, audio, images, written material, or distinctive branding without a separately documented right to do so.

---

## 2. Research baseline: original game versus new implementation

The original game's known mechanics are drawn from contemporary/retrospective descriptions and a community walkthrough, not an authoritative recovered source tree. Details should be verified against legitimate gameplay captures where possible. **“Original documented” does not mean that we possess the original algorithm.**

| Original feature (documented) | Preservation requirement | Modern implementation policy |
| --- | --- | --- |
| Select a U.S. city and inspect industrial buildings with size, rent, and businesses | Retain | Persistent cityscape, real buildings and competitors; additional garage/small-workspace properties |
| Choose buildings and products using local market information | Retain | Industry/product discovery from real marketplace records, not fixed scripted prices |
| Top-down factory layout, then operating/three-quarter viewing | Retain | Editable top-down mode and separate live-observation rendering modes |
| Menubar, toolbars, bottom status bar, floating management dialogs | Retain closely | Classic desktop window manager within Electron renderer, saved per-workspace layout |
| Machinery, offices, conveyors, storage zones, carts, forklifts, safety and break areas | Retain | Spatially coherent equipment components and physical movement capabilities |
| Job advertisements, applicants, wages, job-fit, assignments | Retain | Persistent named candidates, worker skills, contracts, reviews, schedules |
| Purchasing agents, salespeople, accountants, supervisors, researchers | Retain | Automatic work arising from explicit policies and actual staff/task capacity |
| Price / Quality / Value purchase guidelines and configurable sales prices | Retain | Supplier scoring policies, price limits, quality thresholds, approval rules |
| Employees working, moving, taking breaks, producing history reports | Retain | Simulated tasks, needs, on-site positions, and event histories |
| Company and industry reports, consultant research, rivals and rankings | Retain | Auditable accounting, market intelligence with information quality and cost |
| Bank checking/savings, loans and initial financing choices | Retain | Double-entry accounting, deposits, credit terms, repayment and insolvency |
| R&D, product evolution, upgrades and market obsolescence | Retain | Data-driven technologies, recipes, research effort, market adoption and depreciation |
| Turn duration selection and accelerated viewing | Retain the *planning/observing experience* | Continuous deterministic sim with pause/resume and adjustable speed; no uninterruptible long turns |
| Transactions, customers and supplier interactions | Retain | Explicit offers, orders, deliveries, invoices; **negotiated contracts and approvals are extensions**, not claimed as historically identical |
| Expansion and competition | Retain and deepen | Multiple owned/leased facilities, real estate market, competing firms with bounded finances/capacity |

**Important original-game delegation finding:** Accounts describe assigned purchasing staff buying under player policies, sales staff marketing/selling output, and accounting/administrative staff carrying out office work; the player sets purchasing guidelines and product prices. This is the pattern to reproduce. Formal negotiated customer contracts and detailed manager spending limits are specified **new extensions**, because the consulted walkthrough does not establish their original behavior.

Source references (consulted 2026-11-07):

1. [GameFAQs: *Free Enterprise* walkthrough by Playbahnosh (2005)](https://gamefaqs.gamespot.com/pc/197389-free-enterprise/faqs/38554) — starting city, floor layout, worker roles, purchasing policies, research, modes, and live operations.
2. [MobyGames: *Free Enterprise* game page](https://www.mobygames.com/game/2408/free-enterprise/) — developer, 1996 release, product range, and high-level mechanics.
3. [Old-Games: *Free Enterpri$e* retrospective](https://www.old-games.com/download/4268/free-enterpri-e-a-k) — managerial employees, morale, financial operations, and turn model.
4. [MobyGames screenshots](https://www.mobygames.com/game/2408/free-enterprise/screenshots/) — historical UI evidence.
5. [GameSpot review](https://www.gamespot.com/reviews/free-enterprise-review/1900-2536117/) — historical critical perspective on realism and original limitations; do not reproduce those limitations as features.

### 2.1 Fidelity research ledger

Keep `docs/original-reference-ledger.md` with columns: feature ID, evidence URL or self-captured gameplay observation, confidence, original behavior, intended adaptation, test fixture, and IP-safe reproduction method. Distinguish `VERIFIED_ORIGINAL`, `RECONSTRUCTED`, `EXTENDED`, and `OPEN_QUESTION`. Do not fill missing original rules from assumptions without marking them.

---

## 3. User experience and navigation

### 3.1 Startup and world selection

1. Show an understated desktop-style main menu with **New Company**, **Quick Start**, **Load**, **Scenarios**, **Options**, **Help**, and **Exit**.
2. New Company opens a city selection map with cities described by population, average rents, wage conditions, labor availability, suppliers, competitors, transport access, and product-market information.
3. Choosing a city opens a **city/industrial district scene** containing many individually selectable buildings. Businesses and vacant properties coexist. The cityscape is not a generic menu list; it is an interactive visual overview with tooltips and selectable premises.
4. Select a garage, workshop, small commercial unit, warehouse, or factory property. Each listing has actual dimensions, footprint, rentable/usable area, rent/deposit or purchase price, doors/docks, utilities, and permitted uses.
5. Choose business name, president/player character, financing method, and starting capital or scenario. The standard entry allows a modest cash-backed garage/small unit; alternative settings emulate the original's larger initial funding and factory.
6. Enter an empty facility. It has no employees, production equipment, or supplies unless the chosen scenario explicitly includes them. The user hires, purchases, places, and operates everything.

**Property acquisition:** Leasing must require cash for deposit/prepaid rent; purchasing requires cash or financing. Future financing is available from actual banks and is subject to credit limits, collateral and terms. A company may hold multiple facilities in multiple districts/cities. Selecting a site shows its true bounds before purchase.

### 3.2 Business desktop shell

The factory remains visible as the workspace background. Management windows open **over** it, can overlap, move, resize, minimize, maximize within the application, close, and be re-opened independently. Persist each window's bounds, stacking order, last tab, filters, and optional compact/docked state per save/profile. Support multiple report windows simultaneously.

Persistent shell:

- Menubar: **File, View, Company, City, Catalog, Personnel, Operations, Purchasing, Sales, Contracts, Research, Finance, Reports, Window, Help**.
- Toolbar: **City View, Factory, Equipment Catalog, Personnel, Inbox, Bank, Reports, Pause/Run, Speed**.
- Left/center: PixiJS factory view with pan/zoom, selection, placement grid overlays on demand.
- Bottom status bar: date/time, active facility, cash, credit availability, alerts, selected object, speed, simulation state.
- Traditional dialog affordances: title bars, compact tabs, dropdowns, sortable grids, tree navigation, small tooltips, keyboard shortcuts.
- Default theme: muted gray and industrial-blue/green, hard-edged borders, restrained highlights; configurable UI scale for modern displays.
- Tooltips and context help should be useful and factual, not decorative. Support window tiling/cascading and restore layout.

**Workspace wireframe (not a final visual design):**

```text
+ File  View  Company  City  Catalog  Personnel  Operations  Finance  Reports +
| [City] [Factory] [Buy] [Staff] [Inbox] [Bank] [Report]   [||] [>] [>>] |
| +--------------------+                                                  |
| | Personnel          |          VISIBLE FACTORY FLOOR                 |
| |--------------------|    [dock] --> [stores] -> [machine] -> [stock]  |
| | Name    Task  Wage |            staff and products move here       |
| | Nora    Buy   ...  |                                                  |
| +--------------------+      +-------------------------+                 |
|                             | Purchase Guidelines     |                 |
|                             | price / quality / value |                 |
|                             +-------------------------+                 |
+ Facility: Workshop A | Cash: ... | Sim: Running | Date: ... | Alerts: 1 +
```

### 3.3 Factory display modes

- **Layout mode:** clear top-down, accurate orthographic floor plan; snap to 0.5 m grid with sub-grid placement where necessary; machine port overlays; construction/placement controls. Pause when performing structural changes with collision and access implications.
- **Operating mode:** old-school oblique/three-quarter view inspired by the original, preserving physical coordinates, legible objects, visible staff and movement; unobtrusive animation; same authoritative simulation, not a different game mode.
- **Inspection view:** optionally top-down while running to inspect congestion and movement. Switching views never changes simulation outcomes.
- **City view:** shows locations of companies, real estate, roads, and relationships. City zoom and property panel are functional, not decoration.

### 3.4 Information design

Every major object has an inspectable record: employee, machine, physical stock, pallet, workstation, building, competitor, shipment, contract, invoice. Selecting the corresponding sprite opens the same information as a row in a business report. Colors/icons convey actual operational states (idle, working, blocked, damaged, in transit, reserved) with accessible text labels. All graphs and reports are grounded in history recorded by the simulation.

---

## 4. Application architecture

### 4.1 Technology decisions

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop host | Electron | Native window, filesystem, dialogs, packaging, application lifecycle |
| UI and classic window manager | React + TypeScript | Menus, floating dialogs, forms, employee lists, financial reports |
| Factory/city renderer | PixiJS (v8-compatible API) | 2D sprites, viewport camera, selection, spatial overlays, animation |
| Application tooling | electron-vite + Vite | Build and HMR for main/preload/renderer; Windows desktop packaging |
| Simulation | Strict TypeScript, isolated worker thread | Event queue, workers, production, logistics, market, finance, competitors |
| Data store | SQLite via `better-sqlite3` | Save snapshots, transactions, scenario/catalog data, audited history |
| IPC contract | Electron `contextBridge` + validated commands | Narrow renderer-to-simulation interface; no direct Node/DB in UI |
| Schema validation | Zod | External content, commands, DTOs, save compatibility boundaries |
| Test/quality | Jest, ts-jest, Testing Library, Playwright, fast-check, ESLint, Prettier | Logic tests, UI tests, real app smoke tests, invariants and style |
| Installer | electron-builder | Windows packaging, native module rebuild, distribution |

Use **WebGL renderer** as the PixiJS production preference, with a documented fallback strategy. The simulation runs independently of rendering and can be executed in Node/Jest without Electron or a graphics context.

### 4.2 Process topology

```text
             +---------------------- ELECTRON HOST ----------------------+
             | Main process: windows, lifecycle, secure IPC broker      |
             |    |                                                    |
             |    +---- Preload: minimal typed contextBridge API ------+---+
             |    |                                                    |   |
             |    +---- Worker thread: simulation + SQLite owner       |   |
             |         * event queue * firms * people * production     |   |
             |         * ledger * marketplace * deterministic RNG      |   |
             +---------------------------------------------------------+   |
                                                                          v
                        +----------------- RENDERER ------------------------+
                        | React classic desktop shell                       |
                        | PixiJS city/factory canvas                        |
                        | read-only projections + validated user commands  |
                        +--------------------------------------------------+
```

**Ownership rules:**

- The worker owns authoritative mutable world state, simulation clock, deterministic PRNG, event queue, and the single write connection to SQLite.
- Electron main owns platform functions and routes a deliberately small allowlisted IPC surface; it never performs business calculations.
- Renderer owns only interaction and presentation state, not authoritative stock, balances, jobs, or orders. It may optimistically preview placement but commits only after worker validation.
- Simulation sends **versioned snapshots/deltas** and events, not an entire world object on every frame.
- Renderer consumes positions produced by the simulation and interpolates visually between them; interpolation cannot move a product through inaccessible space or change the underlying stock state.

### 4.3 Security and resilience

Set `contextIsolation: true`, `nodeIntegration: false`, and sandbox renderer where compatible. Enforce a restrictive Content Security Policy; disallow remote code loading. Validate every IPC command (`type`, payload, origin/permissions, expected world revision), implement command idempotency, and rate-limit expensive requests. No `eval` or unrestricted filesystem bridges. Content packs are validated, data-only by default, and never execute arbitrary JS in the renderer/worker.

Perform simulation/DB work off the UI thread. Worker crashes trigger a safe pause and recoverable diagnostic, not silent resets. Graceful shutdown requests a consistent checkpoint. Maintain structured logs with rotation; no automatic upload.

### 4.4 Module boundaries

- `domain`: pure entities, value objects, validation, business rules; no Electron, React, PixiJS or SQL imports.
- `simulation`: event queue, worker task planning, movement, market transactions, state transitions.
- `persistence`: SQLite schema, repositories, migrations, snapshots, integrity checks.
- `catalog`: schema-driven data for products, recipes, machines, employee roles, markets, scenarios.
- `ui`: React windows/forms and projections, no simulation mutations.
- `rendering`: PixiJS scene, camera, sprite pooling, selection, visual-only effects.
- `desktop`: Electron main/preload and typed IPC.

Enforce boundaries with lint/dependency rules. No circular imports. Prefer dependency injection/interfaces for clock, RNG, repositories, and services.

---

## 5. Physical world, facilities and real geometry

### 5.1 Coordinate model

Use millimeters as the canonical integer world-space measurement. The main floor construction grid has a **500 mm** pitch, meaning each full tile represents **0.25 m² ≈ 2.69 ft²**. Store tile/world positions and sizes independently of pixel resolution. Display user-friendly square footage (or metric by setting). Scale a room from its documented dimensions; never fit unrelated floor sizes into a single fixed number of tiles.

Example: a 10 ft × 5 ft / 50 sq ft workspace is only about 4.65 m² (about 19 grid cells); it cannot accommodate equipment larger than its actual bounds. A 100 ft × 100 ft / 10,000 sq ft facility represents about 929 m² (about 3,716 grid cells). Tile counts vary by geometry. This is intentional.

Each property records:

- exterior parcel polygon and street access;
- interior floor polygons by level, structural walls, columns and forbidden regions;
- exact usable/rentable areas and dimensions;
- load-bearing limits and utilities (electricity, water, ventilation as needed);
- doors, receiving/shipping zones, docks, parking and vehicle access;
- legal occupancy, occupancy cost, lease terms, ownership/financing;
- connected storage/office/manufacturing zones and pathing network.

Area calculations derive from polygons; allow irregular shapes, mezzanines, attached offices, and multi-floor facilities. Scaling cannot be overridden to make space appear larger.

### 5.2 Physical placement and pathfinding

Equipment has a footprint, orientation, clearance envelope, supply ports, output ports, maintenance access, hazard area, power/utilities requirements, and operator stations. Placement is rejected when any constraint fails. Employees and equipment follow collision-aware routes. Storage capacity is volumetric/weight/footprint-bound; receiving and shipping consume dock capacity. A machine cannot operate while ports are obstructed or required utilities/staff are unavailable.

Use a navigable grid/portal graph with A* or equivalent for walking. Rebuild only affected local graph regions after placement edits. Vehicle paths use separate access and turning constraints. Workers cannot pass through machines or closed walls. Dynamic occupancy prevents deadlocks via reservation/priority/yield rules with deterministic tie-breaks.

### 5.3 Items, lots, pallets, containers and fluids

Model physical stock in layers:

1. **Product definition:** what an item is, its unit, dimensions, weight, quality metrics and processing requirements.
2. **Stock identity:** serialized unit where identity matters, or a **counted lot** for interchangeable units (lot ID, product ID, exact quantity, quality, ownership, batch genealogy).
3. **Load unit:** parcel, stack, crate, pallet, cart, tank, hopper, conveyor segment, or machine buffer with capacity and location.
4. **Movement:** transfer of explicitly reserved quantities between named locations via a worker, conveyor, forklift, vehicle, pipe, or machine operation.
5. **Visual representation:** each physical load unit appears at its true position; a visible crate/pallet represents its exact counted contents, not an invented single item.

**Interpretation of “every product is tangible”:** Every item or precisely counted group must be physically accounted for and visually locatable from entry to exit. For 10,000 identical screws inside a sealed pallet, render the pallet and make the counted contents inspectable rather than drawing 10,000 meaningless sprites. The number, location, ownership, contents, and processing history remain authoritative. Serialized finished goods can be inspected individually. For liquids/bulk material, represent measured quantity in a physical container, pipe, or tank; conservation still applies.

There is **no teleportation** of stock between stations. A move requires a material-handling resource, accessible route, transfer event, and elapsed simulation time. Internal recipes consume recorded inputs and create recorded outputs/scrap; every product shipment is loaded and leaves through a valid exit/dock.

### 5.4 Machine models

Define machines through data and reusable capability modules, not a unique hard-coded class for every product. State machine:

`UNINSTALLED → IDLE → RESERVED/LOADING → SETUP → PROCESSING → UNLOADING → IDLE`, plus `BLOCKED`, `BROKEN`, `MAINTENANCE`, and `UNPOWERED` branches.

Model input/output ports, buffering, throughput, cycle/setup time, batch size, labor stations, wear, energy, consumables, maintenance, defects, product quality, and repair/salvage value. Machine-specific behavior is assembled from standardized processing stages and recipe definitions. Allow conveyors, sorters, storage bins, carts and forklifts to change the feasible flow, not merely its animation.

### 5.5 Receiving → manufacturing → shipping trace

For each accepted purchase order: reserve money/credit according to terms → supplier allocates inventory → carrier picks up real quantities → shipment travels in market simulation → truck arrives through valid property access → authorized employee/handling device unloads to dock → internal transportation places stock into storage or production → production allocates exact inputs → outputs and waste appear in machine buffer → outputs are moved to storage or downstream machines → sales order reserves finished goods → worker stages and loads shipment → carrier departs → title/payment and receivable events settle per contract.

The player's inspection UI must be able to trace any stock lot to its origin, machine transformations, movements and destination. Stock may never be consumed twice, ship before loading, or silently vanish on a worker's task cancellation.

---

## 6. Employees, tasks, departments and delegation

### 6.1 Persistent people

Employee record includes stable ID; full name; appearance sprite/profile; current employer; department and role; wage/salary and payroll classification; hiring date and employment terms; attributes/aptitudes; learned skills; certifications where relevant; stress, morale, fatigue and needs; work schedule and attendance; location; task queue; job history; goals; manager; and performance metrics. Keep trait definitions data-driven and grounded in plausible work effects; do not recreate original sensitive or stereotyped personality mechanics without critical review.

Simulate people while at work with activities such as travel, task setup, operation, paperwork, meetings, breaks, maintenance, idle/social activities, and leaving the premises. Staff that are off shift, absent or out sick are not simultaneously displayed at work. The player/president is a named employee-like actor with configurable manual oversight, not an omnipotent invisible resource.

### 6.2 Department roles

- **Production:** operators, assemblers, packers, quality inspectors, maintenance technicians, line leaders.
- **Logistics:** stock handlers, cart/forklift operators, warehouse workers, dispatchers, receiving clerks.
- **Commercial:** buyers, purchasing manager, sales staff, sales manager, market researcher.
- **Finance/admin:** accountant, payroll administrator, office clerk, controller.
- **Research:** researchers, process engineers, R&D manager.
- **Leadership:** floor supervisor, plant manager, general manager, president.

Employees occupy assigned offices, workstations, machines, or floor routes. Hiring more staff does not automatically create capacity without physical work locations, supplies, equipment and sufficient tasks.

### 6.3 Task model

Each task has unique ID, originating objective/policy, assigned worker or eligible pool, source/destination, resource reservations, prerequisite tasks, expected work requirements, priority, and state:

`PROPOSED → READY → CLAIMED → IN_PROGRESS → COMPLETED` or `BLOCKED / CANCELLED / FAILED`.

Workers choose tasks using capability, fit, priority, proximity, fatigue, availability, and manager policy. Claiming is atomic. Preemptions and failures release/reconcile reserved inputs. Goals are expressed as achievable objectives, not arbitrary buffs. The activity log records where, why, and how long a task took, plus actual output.

### 6.4 Original-style delegation

**Player specifies policy; staff executes it.** A purchasing agent periodically identifies shortages, evaluates known suppliers using the player-defined `PRICE`, `QUALITY`, or `VALUE` weighting, requests quotes, places approved orders, and posts memos on exceptions. A salesperson seeks buyers, negotiates within approved bounds, creates proposals, fulfills sales requests and follows up. An accountant records transactions and creates reports; a supervisor assigns work, monitors congestion and intervenes within remit. None should generate orders, money or inventory without the corresponding resources and business event.

Define explicit policy and authority records by role/manager:

- `AUTOMATION_OFF`: player must approve every action.
- `SUGGEST_ONLY`: agent creates recommendations; no binding actions.
- `WITH_LIMITS`: agent executes within thresholds for budget, price, volume, credit, customer and contract terms.
- `DELEGATED`: agent controls specified area, with guardrails and audit trail.

The player can override any delegated policy, revoke pending uncommitted proposals, approve/decline exceptions, or take direct control. Management skill affects planning quality, prioritization and error rate, not the ability to create goods or money ex nihilo. Reports attribute outcomes to specific decisions.

### 6.5 Employment economy

Hiring ads generate candidate pools constrained by local labor market, wage expectations and skills. Applicants apply with resumes/fit data; the player or recruiter reviews them. Wage offers, salary changes, turnover, training, performance, overtime, shifts and morale produce ongoing costs and measurable output. Payroll posts to the ledger and cash or payable accounts per configured cycle. Staff morale and stress should influence productivity and absence plausibly but avoid gratuitous punitive simulation.

---

## 7. Markets, competitors and contracts

### 7.1 Persistent economic actors

The world contains firms (player and AI competitors), households/aggregate end consumers, institutional customers, suppliers, property owners, banks and logistics providers. Every AI firm has actual inventory, production recipes, equipment/aggregate capacity, labor, funds/debt, purchasing/sales policies, local market share and business strategy. Off-screen factories need not render individual workers, but they must consume inputs, occupy capacity, and incur costs under consistent rules.

### 7.2 Market mechanism

Represent product markets by location, segment, time, quantity demanded/supplied, buyer budgets, substitution, quality expectations, supplier reputations, transport costs and lead times. Companies submit posted offers, RFQs/quotes, contracts and sell orders. A deterministic market-matching process evaluates available counterparties and realistic transaction constraints. Prices emerge from competing offers and buyer willingness to pay, anchored to demand and supply. There is no universal price rollercoaster divorced from orders and inventories.

Demand may react to population, seasonality, spending, substitute products, fashion/technology, and broader conditions. Scenario shocks affect causes—e.g., demand shift, utility outage, material shortage, financing costs—not direct unexplained changes to company profit.

### 7.3 Customer and supplier contracts

Contracts are **intentional modern extensions** of the original's documented procurement/sales delegation. Contract fields: ID, parties, product specifications, quantity/unit, quality tolerance, negotiated unit price or price formula, currency, delivery location, delivery windows (in-game), delivery cadence, lead time, payment terms, deposit, penalties, partial fulfillment, cancellation, termination and status. Support spot transactions, recurring supply agreements, purchase orders and negotiated bids. Terms can be negotiated directly by player or by authorized staff; binding actions record the approving person and policy.

**Transaction lifecycle:** opportunity/RFQ → quotation → counteroffer(s) → agreed contract or spot order → reservations and scheduling → production/procurement → delivery → inspection/acceptance → invoice → payment/receivable settlement → close/dispute/cancel. Model defaults, late deliveries and realistic cost consequences without unexplained arbitrary punishment.

### 7.4 Rival strategy

Rivals make bounded decisions: analyze projected unit contribution, estimate capacity/lead times, purchase or rent space, procure machines, recruit labor, invest in research, seek customers, adjust prices, borrow/repay, and exit when insolvent. Use the same economic invariants as player; avoid unfair hidden subsidies except explicit scenario settings. The market should support competitor expansion and failure with consequences for facilities, wages and product supply.

### 7.5 Research and information

The player can purchase consultant reports and market intelligence. Depth/accuracy depend on collection method, data availability, staff skill and expenditure. Proprietary competitor details are not omniscient by default. Research upgrades product quality, efficiency or new product capabilities through actual staffing, machine resources, and spending; new products must be technically feasible and meet a real demand. No mandatory game-level gate.

---

## 8. Finance, accounting and reporting

### 8.1 Accounting invariants

- Monetary values use **integer minor units** (e.g., cents), never floating-point dollars.
- Transactions use **double-entry journal entries**; per journal transaction, debits equal credits.
- Cash cannot change without a journal entry and identified counterparty/source.
- Inventory acquisition, consumption, scrap, transfer, WIP, and finished goods recognize costs consistently.
- Revenue recognition and payment timing are separate; accounts receivable/payable are explicit.
- Loans have principal, annual rate, term (in-game), accrued interest, collateral where relevant, and repayment obligations.
- Bank checking/savings balances and lending capacity are real accounts; a withdrawal requires available balance or credit.
- Support taxes/fees as optional plausible local rules controlled by scenario data, not arbitrary UI deductions.

### 8.2 Reports and windows

Provide income statement, balance sheet, cash-flow statement, trial balance, bank register, payables/receivables aging, purchase/sales orders, invoices, inventory by location and cost, production throughput, cycle times, bottlenecks, machine utilization/downtime, employee time use, payroll, product profit margins, market shares, debt/loan schedule and company rankings.

Reports should be table-first and drillable to transactions, people and objects. Show both historical and current information, with source traceability, filters, sorting, export to CSV, and no arbitrary summary-only dashboards. Where estimates are used, label them as forecasts with assumptions.

---

## 9. Simulation time, scheduling and consistency

### 9.1 Clock and controls

Time is in-game simulated time, independent of rendering frame rate and system wall clock. Support **Pause, Normal, Faster, Fastest, Advance To End of Day/Week, Advance Until Event, and Single Step** as applicable. The player may pause or interrupt accelerated periods. The original planning/turn rhythm is retained through optional “advance until” controls, without reproducing the original's inability to stop a long running turn.

A deterministic priority queue stores `(gameTime, priority, sequence, eventId)` for stable ordering. Avoid midnight-only batch magic: travel, shifts, deliveries, machine cycles, paperwork and market actions occur at scheduled moments. Use scheduled periodic decisions for strategic AI and accounting closures while local physical operations progress continuously.

### 9.2 Simulation pipeline

1. Validate command and revision; reject impossible/unauthorized actions with reasons.
2. Reserve required labor, space, money, inventory, capacity or transport atomically.
3. Enqueue domain events with deterministic IDs and ordering.
4. Process due events and advance state without coupling to animation frames.
5. Reconcile asset, physical and ledger invariants.
6. Persist event/snapshot according to storage policy.
7. Publish a versioned UI delta and audit event to renderer.

No business outcome may depend on display refresh rate, window visibility, operating system performance, or camera zoom.

### 9.3 Example domain transition

```ts
interface StockTransferCommand {
  commandId: string;
  expectedWorldRevision: number;
  loadUnitId: string;
  fromLocationId: string;
  toLocationId: string;
  handlingResourceId: string;
  quantityMicrounits: bigint;
}

interface SimulationEvent {
  id: string;
  timeMs: bigint;          // simulated milliseconds since scenario epoch
  priority: number;
  sequence: bigint;        // stable event ordering
  type: string;
  payload: unknown;       // validated via event-specific Zod schema
}
```

Validate the complete route and quantity, reserve destination capacity, schedule departure/arrival, then commit stock location at authoritative transition points. Display positions interpolate along the authorized route. Avoid sending JavaScript `bigint` values through JSON serialization without an explicit string codec.

### 9.4 Deterministic randomness

Use a versioned seeded PRNG with persisted state; no `Math.random()` in domain/simulation code. Persist pending events, command sequence, actor state, and PRNG snapshots. All time-related computations use integers or explicitly defined fixed-point quantities. Document rounding rules and deterministic tie-breaks.

---

## 10. Persistence and database specification

### 10.1 SQLite operational settings

Use a single writer, parameterized queries, explicit transactions, foreign keys, indexed references, and a migration system. Enable WAL for runtime speed and safe concurrent reads where appropriate; checkpoint cleanly before copying exported save files, or use the SQLite backup API. Do **not** copy a live `.db` file alone while WAL may contain uncheckpointed changes. Keep application configuration separate from save worlds. Store DB under Electron's `app.getPath('userData')` and allow portable export/import.

Use `better-sqlite3` only in the worker/native Node context, never in the unprivileged browser renderer. Rebuild native modules for Electron's ABI and unpack the native addon when packaging.

### 10.2 Core relational schema (logical baseline)

| Table / group | Role and primary relationships |
| --- | --- |
| `worlds`, `world_metadata`, `schema_migrations` | World identity, seed, content/version, integrity, migration version |
| `cities`, `districts`, `parcels`, `properties`, `facility_floors`, `floor_obstacles`, `dock_points` | Real estate, true physical geometry, occupancy and transport access |
| `firms`, `firm_facilities`, `ownerships`, `leases`, `bank_accounts`, `loans` | Companies, capital, leases and borrowing |
| `people`, `employment`, `roles`, `skills`, `employee_skill_levels`, `shifts`, `attendance` | Persistent staff and labor conditions |
| `workstations`, `machine_instances`, `machine_ports`, `machine_capabilities`, `machine_state` | Manufacturing equipment and physical operating stations |
| `products`, `recipes`, `recipe_inputs`, `recipe_outputs`, `technologies`, `research_projects` | Manufacturing definitions and research |
| `locations`, `stock_lots`, `serialized_items`, `load_units`, `lot_contents`, `stock_movements`, `stock_reservations` | Physical goods and provenance |
| `work_orders`, `tasks`, `task_assignments`, `task_events`, `machine_runs`, `quality_inspections` | Operations, task states and output verification |
| `market_offers`, `rfqs`, `quotes`, `contracts`, `contract_lines`, `purchase_orders`, `sales_orders`, `shipments`, `invoices` | Commercial actions and deliveries |
| `ledger_accounts`, `journal_entries`, `journal_lines`, `payment_allocations`, `inventory_cost_layers` | Double-entry accounting and cost basis |
| `manager_policies`, `delegation_limits`, `approvals`, `memos`, `audit_events` | Player control, staff automation and transparency |
| `simulation_events`, `world_snapshots`, `command_log`, `render_projections`, `save_metadata` | Deterministic replay, resumability, indexed view data |

Use stable UUID/ULID-like IDs (or deterministic sequence-based IDs during simulation), foreign keys, explicit units, and schema migration guards. Never store core simulation state only as an opaque JSON blob. JSON columns can hold versioned details, but financial, inventory, people, and contract relationships should remain queryable.

### 10.3 Illustrative DDL

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE firms (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  city_id TEXT NOT NULL REFERENCES cities(id),
  status TEXT NOT NULL CHECK (status IN ('active','insolvent','closed'))
);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES firm_facilities(id),
  kind TEXT NOT NULL,
  x_mm INTEGER NOT NULL,
  y_mm INTEGER NOT NULL,
  z_mm INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stock_lots (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  owner_firm_id TEXT NOT NULL REFERENCES firms(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  quantity_micro INTEGER NOT NULL CHECK (quantity_micro >= 0),
  unit_cost_cents_micro INTEGER NOT NULL,
  state TEXT NOT NULL,
  parent_lot_id TEXT REFERENCES stock_lots(id)
);

CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  firm_id TEXT NOT NULL REFERENCES firms(id),
  game_time_ms INTEGER NOT NULL,
  description TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE
);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  CHECK (NOT (debit_cents > 0 AND credit_cents > 0))
);
```

**Design note:** SQLite `INTEGER` is signed 64-bit; fixed-point quantity scale and total money limits must be defined and tested to prevent overflow. Source-event/journal idempotency must be enforced in transactions. Some validations (e.g., balancing journal entries) require transactional application logic or deferred triggers; basic DDL constraints alone are insufficient. The above is **illustrative**, not the complete migration.

### 10.4 Save and compatibility requirements

- Save snapshots at a consistent simulation-event boundary and transactionally record schema/content versions, RNG state, event queue, identities, stock reservations, pending deliveries, orders, worker tasks and finances.
- Support named save slots, autosave rolling backups, export/import, and integrity validation.
- Reopen a save and obtain **exactly** the same domain state hash and future outcomes with identical commands.
- Migration operations have preconditions, backups, forward migration tests and clear handling of unsupported old saves.
- Never silently discard corrupt records, unload stock, or zero out accounts. Provide a repair/read-only option and diagnostic report if possible.

---

## 11. Domain and rendering interfaces

### 11.1 TypeScript domain examples

```ts
type Id = string;
type MoneyCents = bigint;
type QuantityMicro = bigint;
type Millimeters = number;       // bounded safe integer

type MachineState =
  | 'idle' | 'reserved' | 'loading' | 'setup' | 'processing'
  | 'unloading' | 'blocked' | 'broken' | 'maintenance' | 'unpowered';

interface FacilityGeometry {
  id: Id;
  floorPolygonMm: readonly { x: Millimeters; y: Millimeters }[];
  usableAreaMm2: bigint;
  entranceIds: readonly Id[];
  maxFloorLoadKgPerM2: number;
}

interface EmployeeState {
  id: Id;
  personId: Id;
  firmId: Id;
  roleId: Id;
  workplaceId: Id | null;
  currentTaskId: Id | null;
  shiftId: Id;
  hourlyWageCents: MoneyCents;
  status: 'off_shift' | 'travelling' | 'working' | 'break' | 'absent';
}

interface MaterialLot {
  id: Id;
  productId: Id;
  quantityMicro: QuantityMicro;
  loadUnitId: Id;
  ownerFirmId: Id;
  qualityCode: string;
  parentLotIds: readonly Id[];
}

interface DelegationPolicy {
  managerId: Id;
  function: 'purchasing' | 'sales' | 'production' | 'staffing' | 'finance';
  mode: 'off' | 'suggest' | 'limited' | 'delegated';
  maxCommitmentCents: MoneyCents | null;
  requiresApprovalAboveCents: MoneyCents | null;
  allowedCounterpartyIds: readonly Id[] | null;
}
```

Domain types are examples of boundary decisions; the authoritative domain package should refine them. JSON IPC and SQLite adapters encode/decode `bigint` deterministically (decimal strings with Zod validation). Do not permit arbitrary JS objects or closures in persisted events.

### 11.2 IPC API contract

Expose renderer-safe, typed APIs such as `simulation.getSnapshot()`, `simulation.submitCommand(command)`, `simulation.subscribeDeltas(callback)`, `simulation.pause()`, `simulation.setSpeed(level)`, `saves.list()`, `saves.save(name)`, `saves.load(id)` and `dialogs.openExport()`. Version every message; reject stale revisions or rebase commands explicitly. Use bounded event buffers and allow full projection resync after missed updates.

### 11.3 PixiJS architecture

Scenes: `CityScene`, `FactoryLayoutScene`, `FactoryOperationScene`, `InspectionOverlay`. Components: `Camera`, `TileGrid`, `BuildingLayer`, `MachineLayer`, `WorkerLayer`, `LoadUnitLayer`, `RouteOverlay`, `SelectionLayer`, `StatusOverlay`. Use reusable spritesheets and atlases. Manage culling, pooling and depth sorting. Camera pan and zoom cannot alter physical scale. Render machine footprint and ports to exact simulation coordinates; provide optional measurement ruler and area overlay.

Update visuals from read-only domain projection messages. Sprite position is computed from authoritative position and interpolation horizon; authoritative physical transfer state remains unchanged until the simulation event occurs. Allow 60 FPS display where supported; when accelerated simulation exceeds rendering capacity, batch visual deltas while preserving simulated event ordering and final positions.

---

## 12. Catalog and content system

### 12.1 Data-driven definitions

Pack original game-inspired classes of manufactured goods into **new, independently authored** content definitions: lumber and wood components, hardware, basic plastics, packaging, appliances, electrical parts, electronics, furniture, industrial components, consumer goods. Support intermediate components and finished products. Do not limit product count to 100; this is a reference to the original game's range, not an arbitrary engine ceiling.

Each `product` definition includes: stable ID, category, unit of measure, physical dimensions/weight or container rules, material class, quality parameters, shelf life where relevant, market preferences, storage requirements, handling equipment, and visual asset reference.

Each `recipe` defines: inputs, output(s), byproducts/scrap, compatible machine capabilities, process stages, batch sizes, setup requirements, labor tasks, quality model and utility consumption. Every conversion is unit-balanced according to explicit yield/loss rules; waste must be accounted for.

### 12.2 Content integrity and mod readiness

Use YAML/JSON content packs with Zod validation, stable IDs, semantic content version, dependency declarations and schema validation tests. Content is declarative. Mods may add data-only products, machines, recipes, industries, sprites and scenarios; executable plugin scripting is out of scope unless explicitly reviewed later for sandboxing. Loading must report duplicates, missing references, impossible dimensions and circular recipes. Changes that invalidate existing saves require migration, content embedding or explicit compatibility messaging.

### 12.3 Localization and units

US customary display by default; store canonical SI/fixed-point values and convert for UI. Round display only, not authoritative simulation quantities. Keep all user-facing strings externalizable; default language English.

---

## 13. Engineering repository and package foundation

### 13.1 Repository layout

```text
FreeIndustry/
├── package.json
├── package-lock.json             # committed, reproducible dependencies
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── tsconfig.jest.json
├── jest.config.cjs
├── eslint.config.mjs
├── .prettierrc.json
├── .prettierignore
├── .editorconfig
├── .gitignore
├── .github/workflows/ci.yml
├── CLAUDE.md
├── README.md
├── LICENSE
├── docs/
│   ├── TechnicalDocument.md
│   ├── original-reference-ledger.md
│   ├── DECISIONS.md
│   ├── GAMEPLAY_RULES.md
│   ├── DATA_MODEL.md
│   └── TESTING.md
├── content/
│   ├── products/
│   ├── machines/
│   ├── recipes/
│   ├── roles/
│   ├── real-estate/
│   └── scenarios/
├── src/
│   ├── main/                    # Electron main, worker host, IPC routing
│   ├── preload/                 # typed, allowlisted bridge
│   ├── worker/                  # isolated simulation + SQLite writer
│   ├── domain/                  # pure TS business rules
│   ├── simulation/              # event loop, market, workers, physical ops
│   ├── persistence/             # schema, migrations, repositories
│   ├── catalog/                 # definition loader + validators
│   ├── renderer/
│   │   ├── app/                 # React root and desktop window manager
│   │   ├── windows/             # personnel, finance, catalog, contracts
│   │   ├── components/
│   │   └── scenes/              # PixiJS scenes
│   └── shared/                  # IPC DTOs and shared read models
├── assets/                      # original licensed or newly created sprites
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── properties/
│   ├── scenarios/
│   └── e2e/
└── scripts/                     # code generation, validation, diagnostics
```

### 13.2 Initial toolchain and dependencies

**Runtime packages:** `react`, `react-dom`, `pixi.js`, `better-sqlite3`, `zod`, and optionally `electron-log` for rotated local diagnostics. Avoid adding a large state-management framework until React's own state and a small typed projection store become insufficient.

**Required development packages:** `electron`, `electron-vite`, `vite`, `@vitejs/plugin-react`, `electron-builder`, `@electron/rebuild`, `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `@types/better-sqlite3`, `jest`, `ts-jest`, `@types/jest`, `jest-environment-jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@playwright/test`, `fast-check`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-config-prettier`, `prettier`, `husky`, `lint-staged`, `cross-env`, `tsx`, `knip`.

Use current compatible **exact package versions resolved when the repository is bootstrapped**, and commit `package-lock.json`. Do not blindly insert guessed future package version numbers into this specification. Verify electron-vite/Vite/Electron/Node engine compatibility before installation. Pin a supported Node LTS major via `.nvmrc` or `.node-version` and record the installed tool versions in `docs/DECISIONS.md`.

### 13.3 `package.json` baseline

The following is a **valid script/config section** to merge into the package manifest after installing packages. Installer commands populate `dependencies` and `devDependencies` with exact versions. `electron-builder.yml` remains authoritative for packaging paths.

```json
{
  "name": "freeindustry",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "start": "electron-vite preview",
    "build": "electron-vite build",
    "pack": "npm run build && electron-builder --dir",
    "dist:win": "npm run build && electron-builder --win",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "jest --runInBand",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage --runInBand",
    "test:e2e": "playwright test",
    "test:all": "npm run typecheck && npm run lint && npm run format:check && npm run test && npm run test:e2e",
    "check:content": "tsx scripts/validate-content.ts",
    "check:deps": "knip",
    "rebuild:native": "electron-rebuild -f -w better-sqlite3",
    "prepare": "husky"
  },
  "lint-staged": {
    "*.{ts,tsx,js,cjs,mjs,json,css,md,yml,yaml}": "prettier --write",
    "*.{ts,tsx,js,cjs,mjs}": "eslint --fix"
  }
}
```

**Bootstrap commands (from a compatible electron-vite React TypeScript scaffold):**

```bash
npm install --save-exact react react-dom pixi.js better-sqlite3 zod
npm install --save-dev --save-exact \
  electron electron-vite vite @vitejs/plugin-react electron-builder @electron/rebuild \
  typescript @types/node @types/react @types/react-dom @types/better-sqlite3 \
  jest ts-jest @types/jest jest-environment-jsdom \
  @testing-library/react @testing-library/jest-dom @playwright/test \
  fast-check eslint @eslint/js typescript-eslint eslint-plugin-react-hooks \
  eslint-plugin-jsx-a11y eslint-config-prettier prettier husky lint-staged \
  cross-env tsx knip
npm run rebuild:native
npm run typecheck
npm run test
```

> On Windows PowerShell, run the package installation as a single line or use PowerShell continuation syntax; the backslashes above represent POSIX line continuations. The scaffold and package compatibility must be verified before running; this is a dependency baseline, not a promise that all newest versions interoperate unmodified.

### 13.4 Test and lint configuration requirements

- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, explicit ESM/bundler resolution, type-safe command and projection interfaces.
- Jest with `ts-jest` and a dedicated `tsconfig.jest.json` that produces compatible CommonJS test output for pure TS domain tests. Use split `node` and `jsdom` Jest projects where appropriate; mock PixiJS GPU context in component tests rather than requiring actual WebGL in JSDOM.
- `@playwright/test` launches the actual Electron application for end-to-end smoke tests, including packaged-build checks. Visual factory interactions need real rendering tests, not only JSDOM.
- ESLint flat config with TypeScript rules, React hooks, accessibility checks and enforced import boundaries. Prettier owns formatting; ESLint should not compete with its style rules.
- Husky pre-commit + lint-staged runs formatting and lint on changed files; CI runs complete validation.
- `fast-check` generates randomized transactions, item transfers, recipes and shift/task scenarios to test invariants.
- Coverage thresholds target **domain correctness**, not superficially inflated coverage of rendered sprite code. Avoid snapshot-test-only validation.
- Windows CI tests typecheck, lint, format, Jest, catalog validation, and a minimal packaged Electron boot. CI retains logs/screenshots for failures.

### 13.5 Native SQLite packaging requirements

`better-sqlite3` contains a native addon. The runtime binary must be rebuilt for the Electron ABI after dependency or Electron upgrades and verified again in a **packaged Windows app**. Configure `electron-builder` to unpack the addon from ASAR and preserve the production dependency. A working `npm run dev` is not evidence that the packaged app can load SQLite. Ensure explicit packaging tests create a world, write data, restart, read it back, and export a save.

### 13.6 Suggested foundational `CLAUDE.md` instructions

```md
# Project engineering rules
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
```

---

## 14. Invariant-driven testing and acceptance criteria

### 14.1 High-priority property tests

| Invariant | Required verification |
| --- | --- |
| Material conservation | For each transformation, input = output + scrap/loss according to recipe units; no negative stock |
| Physical provenance | Each lot's origin, current load unit/location and complete movement sequence can be reconstructed |
| Capacity | No machine, pallet, shelf, dock, building, or vehicle exceeds stated area/volume/weight/cycle capacity |
| Staff reality | No staff member performs two overlapping tasks, works while absent, or moves impossibly |
| Money and ledgers | Every journal balances, no double payment, credit limits respected, bank balances reconcile |
| Orders and shipping | A customer order cannot ship more accepted goods than actually staged/loaded |
| Contracts and delegation | No manager spends beyond authority; player overrides apply to subsequent actions |
| Geometry | A facility always renders at a fixed scale derived from real coordinates and cannot contain equipment outside floor bounds |
| Determinism | Same seed + state + command log results in identical state hash, despite FPS/window changes |
| Persistence | Save/load during active machinery, transit, payroll and pending orders yields identical continuation |
| Competitor constraints | AI firms cannot produce without inputs, capacity, working capital and staff/aggregate labor |
| UI integrity | Closing or moving windows never changes factory outcomes or loses pending approved commands |

### 14.2 Scenario tests

**S01 — Empty garage:** Open new world, inspect the cityscape, lease a physically small premises, view its correct floor geometry; no factory objects/stock/staff are pre-created unless scenario says so.

**S02 — First production:** Purchase material and a machine, place equipment only if it fits, recruit/assign staff, receive materials at dock/door, move stock to machine, process it, stage final goods, sell and dispatch. Validate the quantity/quality/financial ledger and watch all movement.

**S03 — Improper fit:** Attempt to place a machine exceeding garage floor area or route clearance. Rejection explains the violated real-world dimension, and the renderer previews the collision.

**S04 — Manager behavior:** Set purchase preference to quality and authorized budget, hire a purchasing agent, observe purchase choices and memos; change policy to price, then verify subsequent decisions change. Verify approval when cost exceeds limits.

**S05 — Broken machine:** Machine failure pauses processing, preserves exact WIP and reservations, triggers repair task and resumption with no duplication.

**S06 — Demand and competitor:** Introduce a competitor with actual production input/capacity, observe prices and market share respond, then test shortage/expansion/insolvency and their impacts.

**S07 — Multi-site business:** Lease a second property, allocate stock to transfer, ship across the city, receive at the new facility, reconcile logistics and accounting without teleportation.

**S08 — Save/load:** Save during loaded truck movement, running machine and outstanding contract; restart the packaged app and continue to byte-identical deterministic domain output.

**S09 — Desktop UI:** Open personnel, market report, contracts and machine catalog in movable windows while the live factory remains visible; move, resize, tile and save layout; restore exactly.

**S10 — Fast-forward:** Advance a simulated week at high speed and compare to a slow visible run from the same seed and commands. Domain hashes must match.

### 14.3 Performance engineering

Performance budgets are **engineering targets, not development timelines**: a smooth, readable 2D view at common desktop resolutions; efficient simulation over thousands of on-site physical load units and hundreds of employees as a scaling objective; background competitors simulated without rendering unseen activity; UI response remains responsive during accelerated time. Define deterministic benchmark maps and measure events/sec, memory, frame duration, SQLite commit/backup cost and worst-case pathfinding. Profile before optimizing; use spatial indices, event batching, projection diffs, sprite pooling and AI decision cadence rather than compromising physical correctness.

Do not claim a scale target has been met until benchmarks run on real hardware, and keep test fixture sizes and measured results in the repository.

---

## 15. Decision rules for implementation

### 15.1 Definition of complete

A feature is complete only when:

1. Its user-facing workflow functions with keyboard/mouse interaction and error states.
2. Its authoritative simulation command/state transitions exist and obey invariants.
3. It is represented in SQLite with load/save compatibility or is explicitly transient UI-only state.
4. It generates appropriate staff activity, stock movements, financial postings or market effects, as applicable.
5. It has automated tests at appropriate levels and a scenario demonstration.
6. It preserves the factory visibility, windowed presentation and original-school tone.
7. Relevant docs/data schemas are updated with original-vs-extension provenance.

### 15.2 Architectural decision process

If a detail is unspecified, choose the simplest model that preserves physical truth, employee agency, business accounting, and original presentation. Record the choice in `docs/DECISIONS.md`, with alternatives rejected. Ask the project owner before changing any **design law**, dropping an original documented feature, breaking save compatibility, or replacing the agreed stack. Narrow scope by content breadth when needed, **not** by substituting fake inventory/animation or fake competitors.

### 15.3 Priority dependencies (not a schedule)

The architectural dependency path is: **typed domain + deterministic event engine + fixed-point accounting/stock model → physical facility and item handling → staff tasks and machines → purchasing/sales and competitor market → reporting/delegation/research → visual/persistence refinement**. UI scaffolding and a representative end-to-end vertical slice should exist alongside the engine to prevent an impressive backend that fails to create the authentic factory observation experience. This is an implementation dependency map, not a timeline.

### 15.4 Source and license policy

The project must use a new name, new art, original code, and independently authored content. Factual inspection of the original for gameplay understanding does not grant license to redistribute original assets. Maintain a credits/licenses inventory for third-party software and art; check each dependency's distribution license, and choose the project's own license deliberately before releasing source or freeware. Do not equate “free to play” with permission to copy original game assets.

---

## Appendix A — Starter game interaction and factory acceptance walkthrough

1. Launch desktop executable; select **New Company**.
2. Review several cities, inspect competitors/suppliers and rent/salary conditions.
3. Enter the industrial cityscape and visually select a small workshop or garage. Inspect exact rentable area and floor plan.
4. Lease the space; open the floor. No employees or machinery are present.
5. Open **Catalog** in a movable window, select a machine and preview its dimensionally correct footprint. Reject if it does not fit; confirm when it does.
6. Open **Personnel**, place a hiring advertisement, review named applicants, and hire a suitable employee. View their wages and skills and assign a workstation.
7. Open **Purchasing**, inspect suppliers and set a guideline or place a direct material order. A real shipment arrives at a reachable entrance/dock.
8. Watch an employee or handling device move the shipment to a storage location and then the machine. The visible inventory count follows it precisely.
9. Run the machine; watch WIP become finished inventory and any scrap. Interrupt production and inspect the exact state at any time.
10. Open **Sales/Contracts** and choose an actual customer, price and delivery terms. Approve the contract or authorize a salesperson to negotiate within limits.
11. Stage finished goods; watch loading and shipment depart. Observe invoices, inventory, costs, cash/receivables and profitability in movable reports while the factory continues behind them.
12. Save, exit, load, and verify that people, goods, company finances and pending decisions return exactly.

**Acceptance statement:** The player should be able to sit and watch a busy factory and legitimately understand what every person and every visible piece of stock is doing, while using overlapping, movable 1990s-style management windows to direct the enterprise.

---

## Appendix B — Technical reference links

- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-vite documentation](https://electron-vite.org/guide/)
- [PixiJS documentation](https://pixijs.com/)
- [SQLite documentation](https://www.sqlite.org/docs.html)
- [better-sqlite3 repository](https://github.com/WiseLibs/better-sqlite3)
- [electron-builder packaging guide](https://www.electron.build/docs/)
- [Electron native module rebuilding](https://github.com/electron/rebuild)
- [Jest getting started / TypeScript](https://jestjs.io/docs/getting-started)
- [Playwright Electron APIs](https://playwright.dev/docs/api/class-electron)
- [Prettier documentation](https://prettier.io/docs/)

**End of specification.**
