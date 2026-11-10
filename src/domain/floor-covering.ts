import type { Cents } from '../shared/money';
import type { Company } from './company';
import type { EntityId } from './ids';
import type { LevelGeometry } from './facility';
import { ACCOUNT } from './ledger';
import { cellKey } from './region';
import type { SimTimeMs } from './time';

/**
 * Floor coverings, layer 2 of the facility model (spec §5.6, DECISIONS
 * ADR-0046): one material per eligible 500 mm cell, stored sparsely. A cell
 * with no covering record has its building's starting surface, so an
 * untouched floor stores nothing at all.
 *
 * Coverings are independent of the structure (no covering changes the
 * slab's load capacity) and of placed objects (installing, moving or
 * removing equipment never touches a covering, and replacing a covering
 * never touches equipment). Step 08 built the data, its invariants and its
 * persistence; Step 09A orders coverings from a floor contractor, whose job
 * takes time (ADR-0052, `floor-works.ts`).
 */

export const FLOOR_MATERIAL_CATEGORIES = [
  'concrete',
  'polished-concrete',
  'painted-concrete',
  'epoxy',
  'steel-plate',
  'diamond-plate',
  'anti-slip',
  'safety-marking',
  'office',
] as const;
export type FloorMaterialCategory = (typeof FLOOR_MATERIAL_CATEGORIES)[number];

export interface FloorMaterial {
  readonly id: string;
  readonly name: string;
  readonly category: FloorMaterialCategory;
  readonly description: string;
  /** Price to install per square metre, or null for a surface that exists but is not sold (worn concrete). */
  readonly installCentsPerM2: Cents | null;
  /** Price to take this material up per square metre when a cell of it is replaced. */
  readonly removalCentsPerM2: Cents;
  /** Average colour, `#rrggbb`: drawn when zoomed out. */
  readonly colour: string;
  /** Texture atlas set and variant count (Step 09). */
  readonly textureSet: string;
  readonly textureVariants: number;
  /** The material's own visible pattern module (joints, plates), independent of the 500 mm grid. */
  readonly patternMm: { readonly x: number; readonly y: number };
}

export const INSTALLATION_KINDS = ['installation', 'replacement', 'mixed'] as const;
type InstallationKind = (typeof INSTALLATION_KINDS)[number];

/** A floor-works order is `scheduled` while the contractor works and `complete` once laid (ADR-0052). */
export const INSTALLATION_STATUSES = ['scheduled', 'complete'] as const;
type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/** A run of cells along one grid row: `[row, firstCol, endCol)`, in cell coordinates. */
export type CellRun = readonly [row: number, from: number, to: number];

/** The covering of one cell (absent: the building's starting surface). */
export interface FloorCovering {
  readonly propertyId: string;
  readonly level: number;
  readonly col: number;
  readonly row: number;
  readonly materialId: string;
  readonly installationId: EntityId<'floor-installation'>;
}

/**
 * One floor-covering order, the contractor's job (ADR-0046, ADR-0052): who
 * paid, when it was ordered and when the contractor finishes, the material,
 * exactly which cells change (as row runs), their exact covered area, how
 * many of them replaced an installed material, the installation and removal
 * charges, and the balanced journal entry that recognised the cost (the
 * contractor's invoice). The cells take the new material when the job
 * completes; until then they are under works.
 */
export interface CoveringInstallation {
  readonly id: EntityId<'floor-installation'>;
  readonly propertyId: string;
  readonly level: number;
  readonly materialId: string;
  readonly firmId: EntityId<'firm'>;
  /** When it was ordered and paid. */
  readonly atMs: SimTimeMs;
  /** When the contractor finishes and the cells take the new material. */
  readonly completesAtMs: SimTimeMs;
  readonly status: InstallationStatus;
  readonly kind: InstallationKind;
  readonly cells: number;
  readonly areaMm2: bigint;
  /** Cells (and their area) that had an installed material, which is taken up first. */
  readonly replacedCells: number;
  readonly replacedAreaMm2: bigint;
  readonly installCents: Cents;
  readonly removalCents: Cents;
  /** `installCents + removalCents`. */
  readonly costCents: Cents;
  readonly journalEntryId: EntityId<'entry'>;
  /** The cells that change, as canonical row runs. */
  readonly runs: readonly CellRun[];
}

/** The kind of an order from how many of its cells replace an installed material. */
export function installationKindOf(cells: number, replacedCells: number): InstallationKind {
  if (replacedCells === 0) {
    return 'installation';
  }
  return replacedCells === cells ? 'replacement' : 'mixed';
}

/** Every cell of some runs, in order. */
export function* runCells(
  runs: readonly CellRun[],
): Generator<{ readonly col: number; readonly row: number }> {
  for (const [row, from, to] of runs) {
    for (let col = from; col < to; col += 1) {
      yield { col, row };
    }
  }
}

/** Distinct cells as canonical row runs: sorted by row then column, adjacent cells merged. */
export function runsOf(cells: Iterable<{ readonly col: number; readonly row: number }>): CellRun[] {
  const sorted = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);
  const runs: [number, number, number][] = [];
  for (const { col, row } of sorted) {
    const last = runs[runs.length - 1];
    if (last?.[0] === row && col < last[2]) {
      continue; // a repeated cell
    }
    if (last?.[0] === row && last[2] === col) {
      last[2] = col + 1;
    } else {
      runs.push([row, col, col + 1]);
    }
  }
  return runs;
}

/** Whether runs are canonical: positive length, sorted, disjoint and not touching along a row. */
function canonicalRuns(runs: readonly CellRun[]): boolean {
  return runs.every(([row, from, to], index) => {
    const previous = runs[index - 1];
    const sound =
      Number.isSafeInteger(row) &&
      Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      row >= 0 &&
      from >= 0 &&
      to > from;
    return sound && (!previous || previous[0] < row || (previous[0] === row && previous[2] < from));
  });
}

const COLOUR = /^#[0-9a-f]{6}$/;
const MAX_PATTERN_MM = 20_000;

/** Why a material definition is impossible; empty when it is sound. */
export function floorMaterialProblems(material: FloorMaterial): string[] {
  const problems: string[] = [];
  if (material.installCentsPerM2 !== null && material.installCentsPerM2 <= 0n) {
    problems.push('an installation price must be positive');
  }
  if (material.removalCentsPerM2 < 0n) {
    problems.push('the removal price cannot be negative');
  }
  if (!COLOUR.test(material.colour)) {
    problems.push(`colour ${material.colour} is not #rrggbb`);
  }
  if (
    !Number.isInteger(material.textureVariants) ||
    material.textureVariants < 1 ||
    material.textureVariants > 16
  ) {
    problems.push('a texture set has 1–16 variants');
  }
  for (const value of [material.patternMm.x, material.patternMm.y]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PATTERN_MM) {
      problems.push(`the pattern module must be 1–${MAX_PATTERN_MM} mm`);
      break;
    }
  }
  return problems;
}

/** Canonical order of covering records: property, level, row, column. */
export function compareCoverings(a: FloorCovering, b: FloorCovering): number {
  if (a.propertyId !== b.propertyId) {
    return a.propertyId < b.propertyId ? -1 : 1;
  }
  return a.level - b.level || a.row - b.row || a.col - b.col;
}

/** Problems of one installation record on its own (shape, sums, cells); empty when sound. */
function installationShapeProblems(
  installation: CoveringInstallation,
  materials: ReadonlySet<string>,
  geometry: LevelGeometry | null,
): string[] {
  const problems: string[] = [];
  if (!materials.has(installation.materialId)) {
    problems.push(`is of unknown material ${installation.materialId}`);
  }
  if (installation.cells < 1 || installation.areaMm2 <= 0n || installation.costCents <= 0n) {
    problems.push('has no cells, no area or no cost');
  }
  if (installation.installCents + installation.removalCents !== installation.costCents) {
    problems.push('costs something other than its installation and removal charges');
  }
  if (installation.installCents <= 0n || installation.removalCents < 0n) {
    problems.push('has an impossible installation or removal charge');
  }
  if (installation.replacedCells === 0 && installation.removalCents !== 0n) {
    problems.push('charges removal without replacing anything');
  }
  if (
    installation.replacedCells < 0 ||
    installation.replacedCells > installation.cells ||
    installation.replacedAreaMm2 < 0n ||
    installation.replacedAreaMm2 > installation.areaMm2
  ) {
    problems.push('replaces more than it covers');
  }
  if (installation.kind !== installationKindOf(installation.cells, installation.replacedCells)) {
    problems.push(`is recorded as ${installation.kind}, which its cells contradict`);
  }
  if (installation.completesAtMs <= installation.atMs) {
    problems.push('completes before it was ordered');
  }
  if (!canonicalRuns(installation.runs)) {
    problems.push('has cell runs out of order, overlapping or empty');
    return problems;
  }
  if (!geometry) {
    problems.push('is on a level that does not exist');
    return problems;
  }
  let cells = 0;
  let area = 0n;
  for (const { col, row } of runCells(installation.runs)) {
    const covered = geometry.coverage.get(cellKey(col, row)) ?? 0;
    if (covered <= 0) {
      problems.push(`includes cell (${col}, ${row}), which is not eligible`);
      break;
    }
    cells += 1;
    area += BigInt(covered);
  }
  if (cells !== installation.cells || area !== installation.areaMm2) {
    problems.push('records a cell count or area that its cells do not have');
  }
  return problems;
}

/**
 * Cross-checks of the covering layer: every covered cell is eligible (part
 * of the usable floor), every material is known, records are in canonical
 * order without duplicates, every covering was laid by a completed order
 * that includes its cell in its own material, every order is consistent
 * with its cells and balances to the journal entry that recognised it, and
 * every scheduled order is on premises the company leases until after the
 * contractor finishes, clear of every other scheduled order, with none of
 * its cells already in its material.
 */
export function coveringProblems(input: {
  readonly coverings: readonly FloorCovering[];
  readonly installations: readonly CoveringInstallation[];
  readonly materials: ReadonlySet<string>;
  readonly geometryOf: (propertyId: string, level: number) => LevelGeometry | null;
  readonly company: Company | null;
  /** When the company's active lease of a property ends, or null if it holds none. */
  readonly leaseEndOf: (propertyId: string) => SimTimeMs | null;
  /** The building's starting surface. */
  readonly surfaceOf: (propertyId: string) => string | null;
}): string[] {
  const problems: string[] = [];
  const installations = new Map(input.installations.map((item) => [item.id, item]));
  if (installations.size !== input.installations.length) {
    problems.push('a floor installation is recorded twice');
  }
  const covered = new Map<string, FloorCovering>();
  const keyOf = (propertyId: string, level: number, col: number, row: number) =>
    `${propertyId}|${level}|${cellKey(col, row)}`;
  input.coverings.forEach((covering, index) => {
    const at = `floor cell (${covering.col}, ${covering.row}) of ${covering.propertyId} level ${covering.level}`;
    const previous = input.coverings[index - 1];
    if (previous && compareCoverings(previous, covering) >= 0) {
      problems.push(`${at} is out of order or recorded twice`);
    }
    covered.set(keyOf(covering.propertyId, covering.level, covering.col, covering.row), covering);
    if (!input.materials.has(covering.materialId)) {
      problems.push(`${at} is covered in unknown material ${covering.materialId}`);
    }
    const geometry = input.geometryOf(covering.propertyId, covering.level);
    if (!geometry) {
      problems.push(`${at} is on a level that does not exist`);
    } else if ((geometry.coverage.get(cellKey(covering.col, covering.row)) ?? 0) <= 0) {
      problems.push(`${at} is not an eligible cell`);
    }
    const installation = installations.get(covering.installationId);
    if (
      installation?.propertyId !== covering.propertyId ||
      installation.level !== covering.level ||
      installation.status !== 'complete' ||
      installation.materialId !== covering.materialId ||
      !installation.runs.some(
        ([row, from, to]) => row === covering.row && covering.col >= from && covering.col < to,
      )
    ) {
      problems.push(
        `${at} names installation ${covering.installationId}, which did not lay it in ${covering.materialId}`,
      );
    }
  });

  const scheduledCells = new Map<string, string>();
  for (const installation of input.installations) {
    const at = `floor installation ${installation.id}`;
    const geometry = input.geometryOf(installation.propertyId, installation.level);
    problems.push(
      ...installationShapeProblems(installation, input.materials, geometry).map(
        (problem) => `${at} ${problem}`,
      ),
    );
    const company = input.company;
    if (!company) {
      problems.push(`${at} exists but no company does`);
      continue;
    }
    if (installation.firmId !== company.firmId) {
      problems.push(`${at} was paid for by ${installation.firmId}, not the company`);
    }
    const entry = company.ledger.entries.find((item) => item.id === installation.journalEntryId);
    const debits = entry?.lines.reduce((sum, line) => sum + line.debitCents, 0n);
    if (!entry || debits !== installation.costCents) {
      problems.push(`${at} does not balance to its journal entry`);
    } else {
      const debitedTo = (code: string) =>
        entry.lines
          .filter((line) => line.account === code)
          .reduce((sum, line) => sum + line.debitCents, 0n);
      if (
        debitedTo(ACCOUNT.floorInstallation) !== installation.installCents ||
        debitedTo(ACCOUNT.floorRemoval) !== installation.removalCents
      ) {
        problems.push(`${at} is not posted as its installation and removal charges`);
      }
    }
    if (installation.status !== 'scheduled') {
      continue;
    }
    const leaseEnd = input.leaseEndOf(installation.propertyId);
    if (leaseEnd === null || installation.completesAtMs >= leaseEnd) {
      problems.push(`${at} is under way on premises the company will not hold when it finishes`);
    }
    const surface = input.surfaceOf(installation.propertyId);
    for (const { col, row } of runCells(installation.runs)) {
      const key = keyOf(installation.propertyId, installation.level, col, row);
      const other = scheduledCells.get(key);
      if (other !== undefined) {
        problems.push(`${at} and ${other} are both working on cell (${col}, ${row})`);
        break;
      }
      scheduledCells.set(key, installation.id);
      if ((covered.get(key)?.materialId ?? surface) === installation.materialId) {
        problems.push(`${at} would lay cell (${col}, ${row}) in the material it already has`);
        break;
      }
    }
  }
  return problems;
}
