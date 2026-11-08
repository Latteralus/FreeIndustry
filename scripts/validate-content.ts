/**
 * `npm run check:content` (spec §13.3): validate the bundled content pack
 * exactly as the game does when it starts, and print what it contains.
 * Exits non-zero, listing every problem, when the content is invalid.
 */
import { BASE_CONTENT } from '../src/catalog/base-content';
import { validateContent } from '../src/catalog/content-schema';

const result = validateContent(BASE_CONTENT);
if (!result.ok) {
  console.error(`Content is invalid (${result.problems.length} problems):`);
  for (const problem of result.problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
const { catalog } = result;
const { cities, districts, businesses, properties } = catalog.realEstate;
console.log(`Content ${catalog.contentVersion} is valid:`);
console.log(
  `  ${cities.length} cities, ${districts.length} districts, ${properties.length} properties ` +
    `(${properties.filter((property) => property.occupant === null).length} vacant), ` +
    `${businesses.length} businesses, ${catalog.scenarios.length} scenarios`,
);
