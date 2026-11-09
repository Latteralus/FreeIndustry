import {
  buildSceneModel,
  diffScene,
  drawOrder,
  hitTest,
  type SceneObject,
} from '../../../src/renderer/scenes/factory/scene-model';
import { Pool } from '../../../src/renderer/scenes/factory/pool';
import { sampleGarage } from '../../support/sample-facilities';

/**
 * The factory scene model (plan Step 09; ADR-0044, ADR-0046, ADR-0051):
 * stable entity ids, drawing order by layer and height (never screen y),
 * scene diffs by id, and the point-in-footprint hit test every mode shares.
 */

function garageScene() {
  const { property, facilities } = sampleGarage();
  const premises = facilities.premises;
  const level = premises?.levels[0];
  if (!premises || !level) {
    throw new Error('no premises');
  }
  return { property, facilities, level, premises };
}

describe('scene model', () => {
  it('keys every drawn thing by a stable entity id', () => {
    const { property, facilities, level, premises } = garageScene();
    const scene = buildSceneModel(property, level, facilities, premises.propertyId);
    const bench = scene.objects.find((object) => object.kind === 'equipment');
    expect(bench).toMatchObject({
      id: 'equipment:1',
      typeId: 'steel-workbench',
      rect: { x: 0, y: 0, width: 1800, depth: 750 },
      layer: 'objects',
    });
    // The garage's door is on the ground floor's wall.
    expect(scene.objects.some((object) => object.kind === 'door' && object.id === 'door:0')).toBe(
      true,
    );
    // The shelving the dealer still holds is not on the floor.
    expect(scene.objects.some((object) => object.id === 'equipment:2')).toBe(false);
    // Rebuilding gives the same ids in the same order.
    const again = buildSceneModel(property, level, facilities, premises.propertyId);
    expect(again.objects.map((object) => object.id)).toEqual(
      scene.objects.map((object) => object.id),
    );
    expect(diffScene(scene, again)).toEqual({
      added: [],
      changed: [],
      removed: [],
      reordered: false,
    });
  });

  it('orders by layer, then height above the floor, never by screen y', () => {
    const at = (id: string, y: number, heightMm: number): SceneObject => ({
      kind: 'equipment',
      id,
      layer: 'objects',
      heightMm,
      rect: { x: 0, y, width: 500, depth: 500 },
      typeId: 't',
      category: 'c',
      name: id,
      widthMm: 500,
      depthMm: 500,
      rotation: 0,
      zones: [],
      state: 'idle',
    });
    const tallNorth = at('equipment:1', 0, 2000);
    const lowSouth = at('equipment:2', 9000, 800);
    const column: SceneObject = {
      kind: 'feature',
      id: 'feature:0',
      layer: 'structure',
      heightMm: 3,
      rect: { x: 0, y: 20_000, width: 300, depth: 300 },
      feature: 'column',
      name: 'column',
    };
    const sorted = [lowSouth, tallNorth, column].sort(drawOrder).map((object) => object.id);
    // Structure first; then the low machine under the tall one, although the tall one is further north.
    expect(sorted).toEqual(['feature:0', 'equipment:2', 'equipment:1']);
  });

  it('diffs by id: a move changes one object; an installation adds one; removal removes it', () => {
    const { property, facilities, level, premises } = garageScene();
    const before = buildSceneModel(property, level, facilities, premises.propertyId);
    const moved = {
      ...facilities,
      equipment: facilities.equipment.map((item) =>
        item.placement
          ? {
              ...item,
              placement: {
                ...item.placement,
                yMm: 1000,
                footprint: { ...item.placement.footprint, y: 1000 },
              },
            }
          : item,
      ),
    };
    const after = buildSceneModel(property, level, moved, premises.propertyId);
    const diff = diffScene(before, after);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((object) => object.id)).toEqual(['equipment:1']);
    const removed = buildSceneModel(
      property,
      level,
      { ...facilities, equipment: [] },
      premises.propertyId,
    );
    expect(diffScene(before, removed).removed).toEqual(['equipment:1']);
    expect(diffScene(removed, before).added.map((object) => object.id)).toEqual(['equipment:1']);
  });

  it('selects by a point-in-footprint test in millimetres', () => {
    const { property, facilities, level, premises } = garageScene();
    const scene = buildSceneModel(property, level, facilities, premises.propertyId);
    expect(hitTest(scene, 900, 375)?.id).toBe('equipment:1');
    expect(hitTest(scene, 1799, 749)?.id).toBe('equipment:1');
    expect(hitTest(scene, 1800, 375)).toBeNull();
    expect(hitTest(scene, 900, 750)).toBeNull();
    expect(hitTest(scene, 2500, 5000)).toBeNull();
  });
});

describe('sprite pool', () => {
  it('reuses released items and stops creating once the scene is steady', () => {
    let resets = 0;
    const pool = new Pool(
      () => ({ id: '' }),
      (item) => {
        item.id = '';
        resets += 1;
      },
    );
    const a = pool.acquire();
    const b = pool.acquire();
    a.id = 'x';
    pool.release(a);
    pool.release(b);
    expect([pool.created, pool.free, resets]).toEqual([2, 2, 2]);
    for (let round = 0; round < 10; round += 1) {
      const items = [pool.acquire(), pool.acquire()];
      expect(items.every((item) => item.id === '')).toBe(true);
      for (const item of items) {
        pool.release(item);
      }
    }
    expect(pool.created).toBe(2);
    const drained: unknown[] = [];
    pool.drain((item) => drained.push(item));
    expect([drained.length, pool.free]).toEqual([2, 0]);
  });
});
