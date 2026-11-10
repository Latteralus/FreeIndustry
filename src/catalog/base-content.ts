import containers from '../../content/containers/containers.json';
import floorMaterials from '../../content/floor-materials/floor-materials.json';
import equipment from '../../content/machines/equipment.json';
import manifest from '../../content/manifest.json';
import cedarBluff from '../../content/real-estate/cedar-bluff.json';
import products from '../../content/products/products.json';
import harlowFalls from '../../content/real-estate/harlow-falls.json';
import portCalder from '../../content/real-estate/port-calder.json';
import scenarios from '../../content/scenarios/scenarios.json';
import { validateContent, type ContentCatalog, type ContentSources } from './content-schema';

/**
 * FreeIndustry's base content pack, bundled into the build (ADR-0037). The
 * JSON files are imported as data and validated here; they are never
 * executed. `scripts/validate-content.ts` (`npm run check:content`) runs the
 * same validation.
 */
export const BASE_CONTENT: ContentSources = {
  manifest,
  realEstate: {
    'harlow-falls.json': harlowFalls,
    'port-calder.json': portCalder,
    'cedar-bluff.json': cedarBluff,
  },
  scenarios: { 'scenarios.json': scenarios },
  floorMaterials: { 'floor-materials.json': floorMaterials },
  equipment: { 'equipment.json': equipment },
  products: { 'products.json': products },
  containers: { 'containers.json': containers },
};

let cached: ContentCatalog | null = null;

/** The validated base content. Throws, listing every problem, if it is invalid. */
export function baseContent(): ContentCatalog {
  if (cached) {
    return cached;
  }
  const result = validateContent(BASE_CONTENT);
  if (!result.ok) {
    throw new Error(`The bundled content is invalid:\n${result.problems.join('\n')}`);
  }
  cached = result.catalog;
  return cached;
}
