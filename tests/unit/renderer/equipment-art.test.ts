import { baseContent } from '../../../src/catalog/base-content';
import {
  artBounds,
  equipmentArt,
  placeArt,
} from '../../../src/renderer/scenes/factory/equipment-art';
import { sampleGarage } from '../../support/sample-facilities';

/**
 * Placeholder overhead art (plan Step 09; D11, ADR-0044, ADR-0051): every
 * catalog type's drawing covers exactly its footprint in all four quarter
 * turns, never more, and lands exactly on the footprint the worker computes.
 */

const ROTATIONS = [0, 90, 180, 270] as const;

describe('equipment art', () => {
  const types = baseContent().facilities.equipmentTypes;

  it('has a drawing for every catalog type whose extent is exactly its footprint', () => {
    expect(types.length).toBeGreaterThan(10);
    for (const type of types) {
      const art = equipmentArt(type);
      expect(artBounds(art)).toEqual({ x: 0, y: 0, width: type.widthMm, depth: type.depthMm });
      // The first primitive is the housing: the whole footprint, outlined.
      expect(art[0]).toMatchObject({
        kind: 'rect',
        x: 0,
        y: 0,
        width: type.widthMm,
        depth: type.depthMm,
      });
    }
  });

  it('turned a quarter at a time, still fills exactly its turned footprint', () => {
    for (const type of types) {
      for (const rotation of ROTATIONS) {
        const quarter = rotation === 90 || rotation === 270;
        const footprint = {
          x: 1250,
          y: 3500,
          width: quarter ? type.depthMm : type.widthMm,
          depth: quarter ? type.widthMm : type.depthMm,
        };
        const placed = placeArt(equipmentArt(type), type, footprint, rotation);
        expect(artBounds(placed)).toEqual(footprint);
        expect(placed[0]).toMatchObject({ kind: 'rect', ...footprint });
      }
    }
  });

  it('lands on the footprint the worker computed for an installed item', () => {
    const { facilities } = sampleGarage();
    const bench = facilities.equipment.find((item) => item.placement);
    const type = facilities.equipmentTypes.find((candidate) => candidate.id === bench?.typeId);
    if (!bench?.placement || !type) {
      throw new Error('no installed bench');
    }
    const placed = placeArt(
      equipmentArt(type),
      type,
      bench.placement.footprint,
      bench.placement.rotation,
    );
    expect(artBounds(placed)).toEqual(bench.placement.footprint);
  });

  it('is shaded evenly: no offset shadow or side face outside the footprint, only flat fills', () => {
    for (const type of types) {
      for (const primitive of equipmentArt(type)) {
        if (primitive.kind === 'rect') {
          expect(primitive.x).toBeGreaterThanOrEqual(0);
          expect(primitive.y).toBeGreaterThanOrEqual(0);
          expect(primitive.x + primitive.width).toBeLessThanOrEqual(type.widthMm);
          expect(primitive.y + primitive.depth).toBeLessThanOrEqual(type.depthMm);
        }
        expect(Object.keys(primitive)).not.toContain('alpha');
      }
    }
  });
});
