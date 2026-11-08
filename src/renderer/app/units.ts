import type { Units } from './desktop/profile-store';
import { formatCents } from './money-input';

/**
 * Display formatting of the worker's physical quantities (spec §12.3): US
 * customary by default, metric by setting. The simulation keeps integer
 * millimetres and square millimetres; these functions only round for
 * display and never feed a number back into the world.
 */

const MM_PER_INCH = 25.4;
const MM_PER_FOOT = 304.8;
const MM2_PER_SQ_FT = 92_903.04;
const M_PER_MILE = 1_609.344;

const group = (value: number, digits = 0) =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "1,033 sq ft" or "96.0 m²". */
export function formatArea(areaMm2: string, units: Units): string {
  const mm2 = Number(areaMm2);
  return units === 'metric'
    ? `${group(mm2 / 1_000_000, 1)} m²`
    : `${group(Math.round(mm2 / MM2_PER_SQ_FT))} sq ft`;
}

/** "26 ft 3 in" or "8.00 m". */
export function formatLength(mm: number, units: Units): string {
  if (units === 'metric') {
    return `${group(mm / 1000, 2)} m`;
  }
  const totalInches = Math.round(mm / MM_PER_INCH);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return inches === 0 ? `${group(feet)} ft` : `${group(feet)} ft ${inches} in`;
}

/** "26 ft 3 in × 39 ft 4 in" or "8.00 m × 12.00 m". */
export function formatDimensions(widthMm: number, depthMm: number, units: Units): string {
  return `${formatLength(widthMm, units)} × ${formatLength(depthMm, units)}`;
}

/** A road distance in metres: "0.4 mi" or "600 m". */
export function formatDistance(metres: number, units: Units): string {
  if (units === 'metric') {
    return metres < 1000 ? `${group(metres)} m` : `${group(metres / 1000, 1)} km`;
  }
  return `${group(metres / M_PER_MILE, 1)} mi`;
}

/** Floor loading: "102 lb/sq ft" or "500 kg/m²". */
export function formatFloorLoad(kgPerM2: number, units: Units): string {
  return units === 'metric'
    ? `${group(kgPerM2)} kg/m²`
    : `${group(Math.round((kgPerM2 * 2.204_622_6 * MM2_PER_SQ_FT) / 1_000_000))} lb/sq ft`;
}

/** Annual rent per unit area, from the worker's two figures. */
export function formatRentRate(perSqFtYear: string, perM2Year: string, units: Units): string {
  return units === 'metric'
    ? `${formatCents(perM2Year)} per m² a year`
    : `${formatCents(perSqFtYear)} per sq ft a year`;
}

/** Feet or metres per drawing pixel, for scale bars. */
export function scaleBarLength(
  pixelsPerMetre: number,
  units: Units,
): {
  readonly pixels: number;
  readonly label: string;
} {
  // A round length of roughly 80–160 pixels.
  const unitMm = units === 'metric' ? 1000 : MM_PER_FOOT;
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  const pixelsPerUnit = (pixelsPerMetre * unitMm) / 1000;
  const length = candidates.find((value) => value * pixelsPerUnit >= 80) ?? 500;
  return {
    pixels: Math.round(length * pixelsPerUnit),
    label: units === 'metric' ? `${length} m` : `${length} ft`,
  };
}

export const PROPERTY_KIND_LABEL = {
  garage: 'Garage',
  workshop: 'Workshop',
  'commercial-unit': 'Commercial unit',
  'industrial-unit': 'Industrial unit',
  warehouse: 'Warehouse',
  factory: 'Factory',
} as const;

export const USE_LABEL = {
  'light-manufacturing': 'light manufacturing',
  'general-manufacturing': 'general manufacturing',
  assembly: 'assembly',
  storage: 'storage',
  distribution: 'distribution',
  offices: 'offices',
} as const;

export const DOOR_LABEL = {
  personnel: 'personnel door',
  'roller-shutter': 'roller shutter',
  'loading-dock': 'loading dock',
} as const;

export const ROLE_LABEL = {
  manufacturer: 'Manufacturer',
  supplier: 'Supplier',
  buyer: 'Buyer',
} as const;
