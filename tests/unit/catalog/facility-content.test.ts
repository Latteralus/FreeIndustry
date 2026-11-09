import { BASE_CONTENT, baseContent } from '../../../src/catalog/base-content';
import { validateContent, type ContentSources } from '../../../src/catalog/content-schema';
import { usableAreaMm2 } from '../../../src/domain/facility';
import { floorAreaMm2 } from '../../../src/domain/real-estate';
import { must } from '../../support/must';

/**
 * Step 08 content (ADR-0046 – ADR-0048): floor materials, the equipment
 * catalog and each listing's building structure and starting surface,
 * validated by `check:content`, never repaired.
 */

type Json = Record<string, unknown>;
type Sources = ContentSources & { realEstate: Record<string, Json> };

function sources(): Sources {
  return JSON.parse(JSON.stringify(BASE_CONTENT)) as Sources;
}

const listings = (content: Sources, file = 'harlow-falls.json') =>
  must(content.realEstate[file])['properties'] as Json[];
const listing = (content: Sources, id: string, file = 'harlow-falls.json') =>
  must(listings(content, file).find((item) => item['id'] === id));

function problemsOf(content: ContentSources): readonly string[] {
  const result = validateContent(content);
  if (result.ok) {
    throw new Error('expected the content to be refused');
  }
  return result.problems;
}

describe('the bundled facilities content', () => {
  it('every listing has a building with its starting surface, a power intake and a sound structure', () => {
    const { facilities, realEstate } = baseContent();
    expect(facilities.buildings.map((b) => b.propertyId)).toEqual(
      realEstate.properties.map((p) => p.id),
    );
    const materials = new Set(facilities.floorMaterials.map((m) => m.id));
    for (const building of facilities.buildings) {
      expect(materials.has(building.surfaceMaterialId)).toBe(true);
      expect(building.utilities.some((u) => u.kind === 'power')).toBe(true);
    }
    const surface = (id: string) =>
      facilities.buildings.find((b) => b.propertyId === id)?.surfaceMaterialId;
    expect(surface('hf-canal-2')).toBe('concrete-worn');
    expect(surface('hf-ng-1')).toBe('concrete-standard');
    expect(surface('hf-ng-9')).toBe('office-vinyl-tile');
  });

  it('usable area derives from geometry: columns, walls and forbidden zones come off the floor', () => {
    const { facilities, realEstate } = baseContent();
    for (const building of facilities.buildings) {
      const property = must(realEstate.properties.find((p) => p.id === building.propertyId));
      const ground = must(building.levels[0]);
      const removed = ground.features.reduce(
        (sum, f) => sum + BigInt(f.rect.width) * BigInt(f.rect.depth),
        0n,
      );
      const flights = building.stairs.reduce(
        (sum, s) => sum + BigInt(s.flight.width) * BigInt(s.flight.depth),
        0n,
      );
      // Features never overlap in the bundled content, so the subtraction is exact.
      expect(usableAreaMm2(building, property, ground)).toBe(
        floorAreaMm2(property) - removed - flights,
      );
    }
    const mill = must(facilities.buildings.find((b) => b.propertyId === 'pc-harbor-5'));
    expect(must(mill.levels[0]).features.filter((f) => f.kind === 'column')).toHaveLength(28);
  });

  it('has a mezzanine with a stair in the Canal Street industrial unit', () => {
    const unit = must(
      baseContent().facilities.buildings.find((b) => b.propertyId === 'hf-canal-20'),
    );
    expect(unit.levels.map((l) => [l.name, l.elevationMm, l.floorLoadKgPerM2])).toEqual([
      ['Ground floor', 0, 2500],
      ['Mezzanine', 2800, 350],
    ]);
    expect(unit.stairs).toHaveLength(1);
  });

  it('has the materials and equipment of the catalog, with exact footprints', () => {
    const { facilities } = baseContent();
    expect(facilities.floorMaterials.map((m) => m.category)).toEqual(
      expect.arrayContaining([
        'concrete',
        'polished-concrete',
        'painted-concrete',
        'epoxy',
        'steel-plate',
        'diamond-plate',
        'anti-slip',
        'safety-marking',
        'office',
      ]),
    );
    const saw = must(facilities.equipmentTypes.find((t) => t.id === 'sliding-table-panel-saw'));
    expect([saw.widthMm, saw.depthMm]).toEqual([3658, 1829]);
    expect(facilities.equipmentTypes.length).toBeGreaterThanOrEqual(15);
  });
});

describe('invalid facilities content is refused', () => {
  it('an unknown starting surface or equipment field', () => {
    const content = sources();
    listing(content, 'hf-canal-2')['surface'] = 'gold-leaf';
    const problems = problemsOf(content);
    expect(
      problems.some((p) => p.includes('starting surface gold-leaf is not a known floor material')),
    ).toBe(true);
    const other = sources();
    must(((other.equipment['equipment.json'] as Json)['equipment'] as Json[])[0])['magic'] = true;
    expect(problemsOf(other).some((p) => p.startsWith('equipment.json: equipment.0'))).toBe(true);
  });

  it('a grid column straddling a wall, a feature outside the floor', () => {
    const content = sources();
    const factory = listing(content, 'cb-ibp-140', 'cedar-bluff.json');
    (must(factory['structure']) as Json)['columns'] = {
      label: 'Steel column',
      sizeMm: [400, 400],
      xMm: [36000],
      yMm: [60000],
    };
    expect(problemsOf(content)).toContain(
      'cedar-bluff.json: cb-ibp-140: column A1 straddles a wall',
    );
    const other = sources();
    (must(listing(other, 'hf-canal-2')['structure']) as Json)['features'] = [
      { kind: 'obstacle', label: 'Crate', rect: [2800, 0, 400, 400] },
    ];
    expect(problemsOf(other).some((p) => /Crate .* is not inside the floor/.test(p))).toBe(true);
  });

  it('a building whose utility point cannot be reached on foot', () => {
    // A full-width partition between the distribution board and both doors.
    const sealed = sources();
    (must(listing(sealed, 'hf-canal-2')['structure']) as Json)['features'] = [
      { kind: 'wall', label: 'Partition', rect: [0, 4000, 3000, 100] },
    ];
    expect(
      problemsOf(sealed).some((p) =>
        p.includes(
          'Electrical intake and distribution board cannot be reached on foot through a 800 mm way',
        ),
      ),
    ).toBe(true);
  });

  it('a utility the property has no supply for, and a building without a power intake', () => {
    const content = sources();
    const structure = must(listing(content, 'hf-canal-2')['structure']) as Json;
    structure['utilities'] = [
      { kind: 'water', label: 'Tap', edge: 0, offsetMm: 500, widthMm: 400 },
    ];
    const problems = problemsOf(content);
    expect(
      problems.some((p) => p.includes('Tap needs a water supply the property does not have')),
    ).toBe(true);
    expect(problems.some((p) => p.includes('there is no electrical intake'))).toBe(true);
  });
});
