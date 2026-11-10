import type {
  EquipmentTypeView,
  EquipmentView,
  FacilitiesView,
  PremisesLevelView,
  PlacementResult,
  RectView,
} from '../../../shared/ipc/facilities';
import type { PropertyView } from '../../../shared/ipc/real-estate';
import type { StockView } from '../../../shared/ipc/stock';
import type { FactoryMode } from './camera';

/**
 * The factory scene's model (spec §3.3, §3.4, §11.3; DECISIONS ADR-0044,
 * ADR-0046, ADR-0051): what the renderer must show, derived from the
 * worker's read model and nothing else. Every drawn thing has a stable
 * entity id (`equipment:3`, `door:0`, `feature:2`), so the same machine is
 * the same sprite, and the same selection, in every mode. Drawing order is
 * by layer and then height above the floor, never by screen y. The scene
 * applies differences between successive models (added, changed, removed)
 * instead of rebuilding. Pure, so it is tested without a GPU.
 */

/**
 * Layers, bottom to top (spec §5.6). Floor and grid are drawn by their own
 * layers; stock (layer 5, things that move) is drawn over placed equipment.
 */
type SceneLayer = 'structure' | 'objects' | 'stock' | 'overlay';

type DoorKind = PropertyView['doors'][number]['kind'];

export type SceneObject =
  | {
      readonly kind: 'equipment';
      readonly id: string;
      readonly layer: 'objects';
      readonly heightMm: number;
      readonly rect: RectView;
      readonly typeId: string;
      readonly category: string;
      readonly name: string;
      /** The type's own frame size, before its quarter turn. */
      readonly widthMm: number;
      readonly depthMm: number;
      readonly rotation: number;
      readonly zones: NonNullable<EquipmentView['placement']>['zones'];
      /** Operational state shown in operating and inspection modes (Step 13 adds working). */
      readonly state: 'idle';
    }
  | {
      /** A load unit standing on this floor (Step 10): its exact footprint and what is on top. */
      readonly kind: 'load-unit';
      readonly id: string;
      readonly layer: 'stock';
      readonly heightMm: number;
      readonly rect: RectView;
      readonly typeId: string;
      readonly containerKind: string;
      readonly name: string;
      /** The container's own frame size, before its quarter turn. */
      readonly widthMm: number;
      readonly depthMm: number;
      readonly rotation: number;
      readonly colour: string;
      readonly loadColour: string | null;
      /** Plan size of the units it carries, for seams across its load. */
      readonly childMm: { readonly width: number; readonly depth: number } | null;
      /** Load units inside it, at any depth. */
      readonly nestedUnits: number;
      readonly grossMassMg: string;
    }
  | {
      readonly kind: 'feature';
      readonly id: string;
      readonly layer: 'structure';
      readonly heightMm: number;
      readonly rect: RectView;
      readonly feature: PremisesLevelView['features'][number]['kind'];
      readonly name: string;
    }
  | {
      readonly kind: 'door';
      readonly id: string;
      readonly layer: 'structure';
      readonly heightMm: number;
      /** The opening along the wall, from (x1, y1) to (x2, y2). */
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly door: DoorKind;
      readonly widthMm: number;
      readonly name: string;
    }
  | {
      readonly kind: 'keep-clear';
      readonly id: string;
      readonly layer: 'overlay';
      readonly heightMm: 0;
      readonly rect: RectView;
      readonly clear: PremisesLevelView['keepClear'][number]['kind'];
      readonly name: string;
    };

export interface SceneModel {
  readonly levelIndex: number;
  /** Every object, in drawing order. */
  readonly objects: readonly SceneObject[];
}

const LAYER_ORDER: Record<SceneLayer, number> = { structure: 0, objects: 1, stock: 2, overlay: 3 };

/** Drawing order: layer, then height above the floor, then id (a stable tie-break). */
export function drawOrder(a: SceneObject, b: SceneObject): number {
  return (
    LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] ||
    a.heightMm - b.heightMm ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const FEATURE_HEIGHT: Record<PremisesLevelView['features'][number]['kind'], number> = {
  forbidden: 0,
  obstacle: 1,
  wall: 2,
  column: 3,
};

/** Door openings on the ground floor's walls, in millimetres. */
function doorObjects(property: Pick<PropertyView, 'doors' | 'floor'>): SceneObject[] {
  return property.doors.flatMap((door, index): SceneObject[] => {
    const from = property.floor[door.edge];
    const to = property.floor[(door.edge + 1) % property.floor.length];
    if (!from || !to) {
      return [];
    }
    const dx = Math.sign(to.x - from.x);
    const dy = Math.sign(to.y - from.y);
    const x1 = from.x + dx * door.offsetMm;
    const y1 = from.y + dy * door.offsetMm;
    return [
      {
        kind: 'door',
        id: `door:${index}`,
        layer: 'structure',
        heightMm: 10,
        x1,
        y1,
        x2: x1 + dx * door.widthMm,
        y2: y1 + dy * door.widthMm,
        door: door.kind,
        widthMm: door.widthMm,
        name: door.kind,
      },
    ];
  });
}

/** Build the scene of one level of the premises from the worker's views. */
export function buildSceneModel(
  property: Pick<PropertyView, 'doors' | 'floor'>,
  level: PremisesLevelView,
  facilities: Pick<FacilitiesView, 'equipment' | 'equipmentTypes'>,
  propertyId: string,
  stock: Pick<StockView, 'loadUnits' | 'containerTypes'> | null = null,
): SceneModel {
  const types = new Map<string, EquipmentTypeView>(
    facilities.equipmentTypes.map((type) => [type.id, type]),
  );
  const objects: SceneObject[] = [];
  level.features.forEach((feature, index) => {
    objects.push({
      kind: 'feature',
      id: `feature:${index}`,
      layer: 'structure',
      heightMm: FEATURE_HEIGHT[feature.kind],
      rect: feature.rect,
      feature: feature.kind,
      name: feature.label,
    });
  });
  if (level.index === 0) {
    objects.push(...doorObjects(property));
  }
  level.keepClear.forEach((zone, index) => {
    objects.push({
      kind: 'keep-clear',
      id: `keep-clear:${index}`,
      layer: 'overlay',
      heightMm: 0,
      rect: zone.rect,
      clear: zone.kind,
      name: zone.label,
    });
  });
  for (const item of facilities.equipment) {
    const placement = item.placement;
    if (placement?.propertyId !== propertyId || placement.level !== level.index) {
      continue;
    }
    const type = types.get(item.typeId);
    objects.push({
      kind: 'equipment',
      id: item.id,
      layer: 'objects',
      heightMm: type?.heightMm ?? 0,
      rect: placement.footprint,
      typeId: item.typeId,
      category: type?.category ?? '',
      name: item.name,
      widthMm: type?.widthMm ?? placement.footprint.width,
      depthMm: type?.depthMm ?? placement.footprint.depth,
      rotation: placement.rotation,
      zones: placement.zones,
      state: 'idle',
    });
  }
  const containers = new Map((stock?.containerTypes ?? []).map((type) => [type.id, type]));
  for (const unit of stock?.loadUnits ?? []) {
    const { location } = unit;
    const type = containers.get(unit.typeId);
    if (
      location.kind !== 'floor' ||
      location.propertyId !== propertyId ||
      location.level !== level.index ||
      !type
    ) {
      continue;
    }
    const firstChild = stock?.loadUnits.find((candidate) => candidate.id === unit.childIds[0]);
    const childType = firstChild && containers.get(firstChild.typeId);
    objects.push({
      kind: 'load-unit',
      id: unit.id,
      layer: 'stock',
      heightMm: type.maxHeightMm,
      rect: location.rect,
      typeId: unit.typeId,
      containerKind: unit.kind,
      name: unit.name,
      widthMm: type.outerMm.width,
      depthMm: type.outerMm.depth,
      rotation: location.rotation,
      colour: type.colour,
      loadColour: unit.loadColour,
      childMm: childType
        ? { width: childType.outerMm.width, depth: childType.outerMm.depth }
        : null,
      nestedUnits: unit.nestedUnits,
      grossMassMg: unit.grossMassMg,
    });
  }
  objects.sort(drawOrder);
  return { levelIndex: level.index, objects };
}

export interface SceneDiff {
  readonly added: readonly SceneObject[];
  readonly changed: readonly SceneObject[];
  readonly removed: readonly string[];
  /** Whether the drawing order changed (objects must be re-stacked). */
  readonly reordered: boolean;
}

/** Objects compare by value: a re-sent but identical object is unchanged. */
function sameObject(a: SceneObject, b: SceneObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What changed between two scenes, by stable id. */
export function diffScene(previous: SceneModel | null, next: SceneModel): SceneDiff {
  const before = new Map((previous?.objects ?? []).map((object) => [object.id, object]));
  const added: SceneObject[] = [];
  const changed: SceneObject[] = [];
  for (const object of next.objects) {
    const old = before.get(object.id);
    if (!old) {
      added.push(object);
    } else if (!sameObject(old, object)) {
      changed.push(object);
    }
  }
  const ids = new Set(next.objects.map((object) => object.id));
  const removed = [...before.keys()].filter((id) => !ids.has(id));
  const order = (scene: SceneModel | null) =>
    (scene?.objects ?? []).map((object) => object.id).join('|');
  return { added, changed, removed, reordered: order(previous) !== order(next) };
}

/** Whether a world point lies in a rectangle (edges inclusive at the minimum, exclusive at the maximum). */
function containsPoint(rect: RectView, xMm: number, yMm: number): boolean {
  return xMm >= rect.x && xMm < rect.x + rect.width && yMm >= rect.y && yMm < rect.y + rect.depth;
}

/** Objects the player can select: equipment and the load units standing on the floor. */
export type SelectableObject = Extract<SceneObject, { kind: 'equipment' | 'load-unit' }>;

export function isSelectable(object: SceneObject | undefined): object is SelectableObject {
  return object?.kind === 'equipment' || object?.kind === 'load-unit';
}

/**
 * The selectable entity at a world point: the topmost equipment or load
 * unit whose footprint holds it, by drawing order (stock lies over
 * equipment). A plain point-in-footprint test in millimetres, the same in
 * every mode.
 */
export function hitTest(scene: SceneModel, xMm: number, yMm: number): SelectableObject | null {
  for (let index = scene.objects.length - 1; index >= 0; index -= 1) {
    const object = scene.objects[index];
    if (isSelectable(object) && containsPoint(object.rect, xMm, yMm)) {
      return object;
    }
  }
  return null;
}

/** What the scene draws in a frame: the authoritative model plus presentation state. */
export interface SceneFrame {
  readonly mode: FactoryMode;
  readonly scene: SceneModel;
  readonly level: PremisesLevelView;
  readonly surfaceMaterialId: string;
  readonly materials: FacilitiesView['floorMaterials'];
  readonly showGrid: boolean;
  readonly showSubGrid: boolean;
  readonly selectedId: string | null;
  readonly hoverId: string | null;
  /** The worker's verdict on the placement being previewed, or null. */
  readonly preview: PlacementResult | null;
  /**
   * Floor overlays (Step 09A): the cells the floor tool has selected, outlined
   * (`allowed` colours them by the worker's quote), and the cells under a
   * contractor's works, hatched. Runs are `[row, firstCol, endCol)`.
   */
  readonly floorMarks?:
    | {
        readonly selection: readonly (readonly [number, number, number])[];
        readonly allowed: boolean | null;
        readonly works: readonly (readonly [number, number, number])[];
      }
    | undefined;
}
