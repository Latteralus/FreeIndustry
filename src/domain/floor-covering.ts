import type { Cents } from '../shared/money';
import type { Company } from './company';
import type { EntityId } from './ids';
import type { LevelGeometry } from './facility';
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
 * never touches equipment). Step 08 builds the data, its invariants and its
 * persistence; buying and installing coverings is plan Step 09A, and the
 * renderer draws them from Step 09.
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
type FloorMaterialCategory = (typeof FLOOR_MATERIAL_CATEGORIES)[number];

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
 * One floor-covering order: who paid, when, which kind of work, how many
 * cells, their exact covered area and the cost, and the balanced journal
 * entry that recognised its cost (normally the contractor's invoice).
 */
export interface CoveringInstallation {
  readonly id: EntityId<'floor-installation'>;
  readonly propertyId: string;
  readonly firmId: EntityId<'firm'>;
  readonly atMs: SimTimeMs;
  readonly kind: InstallationKind;
  readonly cells: number;
  readonly areaMm2: bigint;
  readonly costCents: Cents;
  readonly journalEntryId: EntityId<'entry'>;
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
function compareCoverings(a: FloorCovering, b: FloorCovering): number {
  if (a.propertyId !== b.propertyId) {
    return a.propertyId < b.propertyId ? -1 : 1;
  }
  return a.level - b.level || a.row - b.row || a.col - b.col;
}

/**
 * Cross-checks of the covering layer: every covered cell is eligible (part
 * of the usable floor), every material is known, records are in canonical
 * order without duplicates, and every installation is consistent with its
 * cells and balances to the journal entry that recognised it in the company's books.
 */
export function coveringProblems(input: {
  readonly coverings: readonly FloorCovering[];
  readonly installations: readonly CoveringInstallation[];
  readonly materials: ReadonlySet<string>;
  readonly geometryOf: (propertyId: string, level: number) => LevelGeometry | null;
  readonly company: Company | null;
}): string[] {
  const problems: string[] = [];
  const installations = new Map(input.installations.map((item) => [item.id, item]));
  if (installations.size !== input.installations.length) {
    problems.push('a floor installation is recorded twice');
  }
  const referencing = new Map<string, number>();
  input.coverings.forEach((covering, index) => {
    const at = `floor cell (${covering.col}, ${covering.row}) of ${covering.propertyId} level ${covering.level}`;
    const previous = input.coverings[index - 1];
    if (previous && compareCoverings(previous, covering) >= 0) {
      problems.push(`${at} is out of order or recorded twice`);
    }
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
    if (installation?.propertyId !== covering.propertyId) {
      problems.push(`${at} names installation ${covering.installationId}, which is not on it`);
    }
    referencing.set(covering.installationId, (referencing.get(covering.installationId) ?? 0) + 1);
  });
  for (const installation of input.installations) {
    const at = `floor installation ${installation.id}`;
    if (installation.cells < 1 || installation.areaMm2 <= 0n || installation.costCents < 0n) {
      problems.push(`${at} has no cells, no area or a negative cost`);
    }
    if ((referencing.get(installation.id) ?? 0) > installation.cells) {
      problems.push(`${at} covers more cells than it records`);
    }
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
    }
  }
  return problems;
}
