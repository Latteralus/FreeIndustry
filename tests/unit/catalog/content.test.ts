import { BASE_CONTENT, baseContent } from '../../../src/catalog/base-content';
import {
  realEstateFor,
  validateContent,
  type ContentSources,
} from '../../../src/catalog/content-schema';
import { floorAreaMm2, upfrontCostOf } from '../../../src/domain/real-estate';
import { must } from '../../support/must';

/** A deep copy of the bundled content that a test can break. */
function sources(): ContentSources & { realEstate: Record<string, Record<string, unknown>> } {
  return JSON.parse(JSON.stringify(BASE_CONTENT)) as ContentSources & {
    realEstate: Record<string, Record<string, unknown>>;
  };
}

type Json = Record<string, unknown>;
const harlow = (content: ReturnType<typeof sources>) =>
  content.realEstate['harlow-falls.json'] as Json;
const listings = (content: ReturnType<typeof sources>) => harlow(content)['properties'] as Json[];

function problemsOf(content: ContentSources): readonly string[] {
  const result = validateContent(content);
  if (result.ok) {
    throw new Error('expected the content to be refused');
  }
  return result.problems;
}

describe('the bundled content pack', () => {
  it('is valid: three cities, their districts, properties, businesses and scenarios', () => {
    const catalog = baseContent();
    expect(catalog.contentVersion).toBe('freeindustry-base/1');
    const { cities, districts, properties, businesses } = catalog.realEstate;
    expect(cities.map((city) => city.name)).toEqual(['Harlow Falls', 'Port Calder', 'Cedar Bluff']);
    expect(districts).toHaveLength(6);
    expect(properties).toHaveLength(41);
    expect(properties.filter((property) => property.occupant === null)).toHaveLength(27);
    expect(businesses).toHaveLength(17);
    expect(new Set(properties.map((property) => property.kind))).toEqual(
      new Set(['garage', 'workshop', 'commercial-unit', 'industrial-unit', 'warehouse', 'factory']),
    );
    expect(catalog.scenarios.map((scenario) => scenario.id)).toEqual([
      'standard',
      'backed',
      'quick-start',
    ]);
    // Every city has vacant property of more than one kind to choose from.
    for (const city of cities) {
      const vacant = properties.filter(
        (property) =>
          property.occupant === null &&
          districts.some(
            (district) => district.id === property.districtId && district.cityId === city.id,
          ),
      );
      expect(new Set(vacant.map((property) => property.kind)).size).toBeGreaterThan(2);
    }
  });

  it('offers genuinely different properties: real sizes, costs and services, not labels', () => {
    const { properties } = baseContent().realEstate;
    const areas = properties.map((property) => floorAreaMm2(property));
    const smallest = areas.reduce((a, b) => (a < b ? a : b));
    const largest = areas.reduce((a, b) => (a > b ? a : b));
    // A lock-up garage of about 17 m² up to a 5,400 m² factory hall.
    expect(smallest).toBeLessThan(20_000_000n);
    expect(largest).toBeGreaterThan(5_000_000_000n);
    expect(new Set(properties.map((property) => property.rentCentsPerMonth)).size).toBeGreaterThan(
      25,
    );
    expect(new Set(properties.map((property) => upfrontCostOf(property))).size).toBeGreaterThan(25);
    expect(new Set(properties.map((property) => property.powerKva)).size).toBeGreaterThan(5);
    expect(new Set(properties.map((property) => property.clearHeightMm)).size).toBeGreaterThan(4);
    // Money is the constraint (D08): a standard start cannot pay what the largest
    // vacant buildings ask on signing; the backed start can pay for any of them.
    const capitalOf = (id: string) =>
      baseContent().scenarios.find((scenario) => scenario.id === id)?.defaultCapitalCents ?? 0n;
    const vacant = properties.filter((property) => property.occupant === null);
    expect(vacant.some((property) => upfrontCostOf(property) > capitalOf('standard'))).toBe(true);
    expect(
      vacant
        .filter((property) => property.kind === 'garage')
        .every((property) => upfrontCostOf(property) <= capitalOf('standard')),
    ).toBe(true);
    expect(vacant.every((property) => upfrontCostOf(property) <= capitalOf('backed'))).toBe(true);
  });

  it('gives each scenario the same real estate, labelled with the scenario and content version', () => {
    const catalog = baseContent();
    const quick = catalog.scenarios.find((scenario) => scenario.quickStart !== null);
    expect(quick?.quickStart).toMatchObject({ propertyId: 'hf-canal-8', termMonths: 12 });
    const estate = realEstateFor(catalog, must(quick));
    expect(estate.scenario).toEqual({ id: 'quick-start', name: 'Quick Start' });
    expect(estate.contentVersion).toBe('freeindustry-base/1');
    expect(estate.leases).toEqual([]);
  });
});

describe('invalid content is refused with every problem named', () => {
  it('unknown fields and wrong types', () => {
    const content = sources();
    must(listings(content)[0])['secret'] = 1;
    must(listings(content)[1])['rentCentsPerMonth'] = '110.00';
    const problems = problemsOf(content);
    expect(problems.some((problem) => problem.startsWith('harlow-falls.json: properties.0'))).toBe(
      true,
    );
    expect(
      problems.some((problem) =>
        problem.startsWith('harlow-falls.json: properties.1.rentCentsPerMonth'),
      ),
    ).toBe(true);
  });

  it('duplicate identifiers and missing references', () => {
    const content = sources();
    must(listings(content)[1])['id'] = 'hf-canal-2';
    must(listings(content)[2])['district'] = 'atlantis';
    must(listings(content)[3])['occupiedBy'] = 'nobody-at-all';
    const problems = problemsOf(content);
    expect(problems).toContain('identifier hf-canal-2 is used twice');
    expect(problems).toContain(
      'harlow-falls.json: hf-canal-8 is in district atlantis, which harlow-falls.json lacks',
    );
    expect(problems).toContain(
      'harlow-falls.json: hf-canal-12 is occupied by nobody-at-all, not a business of Harlow Falls',
    );
  });

  it('impossible dimensions: doors outside their wall, a non-rectilinear floor', () => {
    const content = sources();
    const garage = must(listings(content)[0]);
    must((garage['doors'] as Json[])[0])['offsetMm'] = 2900;
    must(listings(content)[1])['floor'] = [
      [0, 0],
      [3000, 0],
      [3000, 6000],
      [100, 5000],
    ];
    const problems = problemsOf(content);
    expect(problems).toContain('property hf-canal-2: door 0 does not fit within its 3000 mm wall');
    expect(problems).toContain('property hf-canal-4: floor: edge 2 is not along a wall axis');
  });

  it('buildings that overlap each other, stand on a street or leave their site', () => {
    const content = sources();
    const [first, second, third] = listings(content) as [Json, Json, Json];
    second['site'] = first['site'];
    third['site'] = [12, 118];
    must(listings(content)[4])['site'] = [370, 10];
    const problems = problemsOf(content);
    expect(problems).toContain(
      'harlow-falls.json: canal-street-works: hf-canal-2 overlaps hf-canal-4',
    );
    expect(problems).toContain(
      'harlow-falls.json: canal-street-works: hf-canal-8 stands on Canal Street',
    );
    expect(problems).toContain(
      'harlow-falls.json: canal-street-works: hf-canal-20 extends beyond the district site plan',
    );
  });

  it('scenarios that could not be played', () => {
    const content = sources();
    const file = must(
      (content.scenarios as Record<string, { scenarios: Json[] }>)['scenarios.json'],
    );
    const [standard, backed, quick] = file.scenarios as [Json, Json, Json];
    standard['epoch'] = '1996-02-30';
    backed['id'] = 'standard';
    const preset = quick['quickStart'] as Json;
    preset['propertyId'] = 'hf-canal-12';
    preset['termMonths'] = 2;
    quick['defaultCapitalCents'] = 100_000;
    const problems = problemsOf(content);
    expect(problems).toContain(
      'scenarios.json: standard starts on 1996-02-30, which is not a date',
    );
    expect(problems).toContain('scenarios.json: standard is defined twice');
    expect(problems).toContain(
      'scenarios.json: quick-start quick-starts in hf-canal-12, which is occupied',
    );
    expect(problems).toContain(
      'scenarios.json: quick-start quick-starts on a term hf-canal-12 does not offer',
    );
    expect(problems.some((problem) => problem.includes('cannot afford its quick start'))).toBe(
      true,
    );
  });

  it('a manifest that does not match the files provided', () => {
    const content = sources();
    const { ['cedar-bluff.json']: _dropped, ...rest } = content.realEstate;
    const problems = problemsOf({ ...content, realEstate: rest });
    expect(problems[0]).toBe(
      'manifest.json lists real-estate files harlow-falls.json, port-calder.json, cedar-bluff.json but harlow-falls.json, port-calder.json were provided',
    );
  });
});
