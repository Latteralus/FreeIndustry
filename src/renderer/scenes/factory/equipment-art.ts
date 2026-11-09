import type { RectView } from '../../../shared/ipc/facilities';

/**
 * Placeholder overhead art for equipment (spec §3.3, D11; DECISIONS
 * ADR-0044, ADR-0051), newly authored for FreeIndustry: simple vector
 * drawings of each machine's top surface, as seen from directly above.
 *
 * - **Fitted to the footprint.** Every drawing is made in the type's own frame
 *   (width along u, depth along v, front at +v, as the domain defines it) and
 *   its first primitive is the housing, exactly the footprint. Nothing is
 *   drawn outside it. The worker's footprint is authoritative; the art is
 *   mapped onto it by the same exact quarter turn the domain uses.
 * - **Neutral shading.** Flat fills, a slightly lighter top panel and a
 *   darker edge, the same on every side: no side faces, no offset shadows,
 *   no directional light, so a quarter turn is still correct.
 * - **Restrained colour.** Practical industrial greens, greys, blues and wood,
 *   with a muted accent where a part matters (a chuck, a ram, a hopper).
 *
 * Pure data, tested in Node; the PixiJS scene only draws the primitives.
 */

export type ArtPrimitive =
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly depth: number;
      readonly fill: number;
      readonly stroke?: number;
    }
  | {
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly fill: number;
      readonly stroke?: number;
    }
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly stroke: number;
    };

export interface ArtType {
  readonly id: string;
  readonly category: string;
  readonly widthMm: number;
  readonly depthMm: number;
}

const COLOUR = {
  edge: 0x23282c,
  machineGreen: 0x5c7261,
  machineGreenTop: 0x6b8270,
  steel: 0x878d92,
  steelTop: 0x9aa0a4,
  blueGrey: 0x55677a,
  blueGreyTop: 0x647789,
  dark: 0x33383c,
  rubber: 0x26292b,
  wood: 0x9a8262,
  woodTop: 0xa98f6c,
  oven: 0x7a7468,
  ovenTop: 0x888174,
  rack: 0x3f5a78,
  rackBeam: 0xb07a2c,
  accent: 0xb59a3a,
  panel: 0x2f3b45,
  chuck: 0x6e6e6a,
  paper: 0xd8d4c8,
} as const;

const rect = (
  x: number,
  y: number,
  width: number,
  depth: number,
  fill: number,
  stroke?: number,
): ArtPrimitive =>
  stroke === undefined
    ? { kind: 'rect', x, y, width, depth, fill }
    : { kind: 'rect', x, y, width, depth, fill, stroke };
const circle = (cx: number, cy: number, r: number, fill: number, stroke?: number): ArtPrimitive =>
  stroke === undefined
    ? { kind: 'circle', cx, cy, r, fill }
    : { kind: 'circle', cx, cy, r, fill, stroke };
const line = (x1: number, y1: number, x2: number, y2: number, stroke: number): ArtPrimitive => ({
  kind: 'line',
  x1,
  y1,
  x2,
  y2,
  stroke,
});

/** The housing (exactly the footprint) and a lighter top panel inset evenly on every side. */
function housing(W: number, D: number, body: number, top: number): ArtPrimitive[] {
  const inset = Math.round(Math.min(W, D) * 0.08);
  return [
    rect(0, 0, W, D, body, COLOUR.edge),
    rect(inset, inset, W - 2 * inset, D - 2 * inset, top),
  ];
}

/** A control panel strip along the front (operator) side. */
function frontPanel(W: number, D: number): ArtPrimitive {
  const depth = Math.max(40, Math.round(D * 0.08));
  const width = Math.round(W * 0.3);
  return rect(
    Math.round((W - width) / 2),
    D - depth - Math.round(D * 0.04),
    width,
    depth,
    COLOUR.panel,
  );
}

type Drawing = (W: number, D: number) => ArtPrimitive[];

const BY_TYPE: Record<string, Drawing> = {
  'steel-workbench': (W, D) => [
    ...housing(W, D, COLOUR.steel, COLOUR.steelTop),
    rect(
      Math.round(W * 0.06),
      Math.round(D * 0.62),
      Math.round(W * 0.1),
      Math.round(D * 0.3),
      COLOUR.dark,
    ),
    line(
      Math.round(W * 0.3),
      Math.round(D * 0.5),
      Math.round(W * 0.9),
      Math.round(D * 0.5),
      COLOUR.steel,
    ),
  ],
  'packing-bench': (W, D) => [
    ...housing(W, D, COLOUR.wood, COLOUR.woodTop),
    rect(
      Math.round(W * 0.05),
      Math.round(D * 0.05),
      Math.round(W * 0.9),
      Math.round(D * 0.18),
      COLOUR.dark,
    ),
    rect(
      Math.round(W * 0.35),
      Math.round(D * 0.4),
      Math.round(W * 0.3),
      Math.round(D * 0.35),
      COLOUR.paper,
    ),
  ],
  'floor-drill-press': (W, D) => {
    const r = Math.round(Math.min(W, D) * 0.28);
    return [
      ...housing(W, D, COLOUR.dark, COLOUR.machineGreen),
      circle(Math.round(W / 2), Math.round(D * 0.58), r, COLOUR.steelTop, COLOUR.edge),
      circle(
        Math.round(W / 2),
        Math.round(D * 0.22),
        Math.round(r * 0.45),
        COLOUR.machineGreenTop,
        COLOUR.edge,
      ),
    ];
  },
  'horizontal-bandsaw': (W, D) => {
    const r = Math.round(Math.min(W * 0.16, D * 0.3));
    return [
      ...housing(W, D, COLOUR.machineGreen, COLOUR.machineGreenTop),
      circle(Math.round(W * 0.2), Math.round(D * 0.4), r, COLOUR.dark, COLOUR.edge),
      circle(Math.round(W * 0.8), Math.round(D * 0.4), r, COLOUR.dark, COLOUR.edge),
      line(
        Math.round(W * 0.2),
        Math.round(D * 0.4 + r),
        Math.round(W * 0.8),
        Math.round(D * 0.4 + r),
        COLOUR.steelTop,
      ),
      rect(
        Math.round(W * 0.4),
        Math.round(D * 0.72),
        Math.round(W * 0.2),
        Math.round(D * 0.18),
        COLOUR.steel,
      ),
    ];
  },
  'pedestal-grinder': (W, D) => [
    ...housing(W, D, COLOUR.dark, COLOUR.machineGreen),
    rect(
      Math.round(W * 0.35),
      Math.round(D * 0.3),
      Math.round(W * 0.3),
      Math.round(D * 0.4),
      COLOUR.machineGreenTop,
      COLOUR.edge,
    ),
    rect(
      Math.round(W * 0.12),
      Math.round(D * 0.25),
      Math.round(W * 0.16),
      Math.round(D * 0.5),
      COLOUR.chuck,
      COLOUR.edge,
    ),
    rect(
      Math.round(W * 0.72),
      Math.round(D * 0.25),
      Math.round(W * 0.16),
      Math.round(D * 0.5),
      COLOUR.chuck,
      COLOUR.edge,
    ),
  ],
  'mig-welding-station': (W, D) => [
    ...housing(W, D, COLOUR.steel, COLOUR.steelTop),
    rect(
      Math.round(W * 0.68),
      Math.round(D * 0.08),
      Math.round(W * 0.26),
      Math.round(D * 0.3),
      COLOUR.blueGrey,
      COLOUR.edge,
    ),
    circle(
      Math.round(W * 0.81),
      Math.round(D * 0.6),
      Math.round(Math.min(W, D) * 0.1),
      COLOUR.rubber,
    ),
    line(
      Math.round(W * 0.1),
      Math.round(D * 0.3),
      Math.round(W * 0.55),
      Math.round(D * 0.3),
      COLOUR.dark,
    ),
    line(
      Math.round(W * 0.1),
      Math.round(D * 0.6),
      Math.round(W * 0.55),
      Math.round(D * 0.6),
      COLOUR.dark,
    ),
  ],
  'engine-lathe': (W, D) => [
    ...housing(W, D, COLOUR.machineGreen, COLOUR.machineGreenTop),
    rect(
      Math.round(W * 0.04),
      Math.round(D * 0.12),
      Math.round(W * 0.2),
      Math.round(D * 0.6),
      COLOUR.machineGreen,
      COLOUR.edge,
    ),
    circle(
      Math.round(W * 0.27),
      Math.round(D * 0.42),
      Math.round(D * 0.18),
      COLOUR.chuck,
      COLOUR.edge,
    ),
    rect(
      Math.round(W * 0.3),
      Math.round(D * 0.38),
      Math.round(W * 0.55),
      Math.round(D * 0.08),
      COLOUR.steelTop,
    ),
    rect(
      Math.round(W * 0.48),
      Math.round(D * 0.2),
      Math.round(W * 0.12),
      Math.round(D * 0.56),
      COLOUR.steel,
      COLOUR.edge,
    ),
    rect(
      Math.round(W * 0.84),
      Math.round(D * 0.25),
      Math.round(W * 0.12),
      Math.round(D * 0.34),
      COLOUR.machineGreen,
      COLOUR.edge,
    ),
    frontPanel(W, D),
  ],
  'vertical-mill': (W, D) => [
    ...housing(W, D, COLOUR.blueGrey, COLOUR.blueGreyTop),
    rect(
      Math.round(W * 0.08),
      Math.round(D * 0.5),
      Math.round(W * 0.84),
      Math.round(D * 0.22),
      COLOUR.steelTop,
      COLOUR.edge,
    ),
    circle(
      Math.round(W / 2),
      Math.round(D * 0.32),
      Math.round(Math.min(W, D) * 0.16),
      COLOUR.blueGrey,
      COLOUR.edge,
    ),
    circle(
      Math.round(W / 2),
      Math.round(D * 0.32),
      Math.round(Math.min(W, D) * 0.06),
      COLOUR.chuck,
    ),
    frontPanel(W, D),
  ],
  'sliding-table-panel-saw': (W, D) => [
    ...housing(W, D, COLOUR.steel, COLOUR.steelTop),
    rect(0, 0, Math.round(W * 0.22), D, COLOUR.blueGreyTop, COLOUR.edge),
    line(
      Math.round(W * 0.42),
      Math.round(D * 0.1),
      Math.round(W * 0.42),
      Math.round(D * 0.9),
      COLOUR.dark,
    ),
    rect(
      Math.round(W * 0.6),
      Math.round(D * 0.1),
      Math.round(W * 0.03),
      Math.round(D * 0.8),
      COLOUR.accent,
    ),
  ],
  'edge-bander': (W, D) => [
    ...housing(W, D, COLOUR.blueGrey, COLOUR.blueGreyTop),
    rect(0, Math.round(D * 0.72), W, Math.round(D * 0.16), COLOUR.rubber),
    rect(
      Math.round(W * 0.06),
      Math.round(D * 0.15),
      Math.round(W * 0.12),
      Math.round(D * 0.4),
      COLOUR.dark,
      COLOUR.edge,
    ),
    frontPanel(W, D),
  ],
  'hydraulic-press-50t': (W, D) => {
    const r = Math.round(Math.min(W, D) * 0.07);
    const inset = Math.round(Math.min(W, D) * 0.14);
    return [
      ...housing(W, D, COLOUR.machineGreen, COLOUR.machineGreenTop),
      circle(inset, inset, r, COLOUR.steel, COLOUR.edge),
      circle(W - inset, inset, r, COLOUR.steel, COLOUR.edge),
      circle(inset, D - inset, r, COLOUR.steel, COLOUR.edge),
      circle(W - inset, D - inset, r, COLOUR.steel, COLOUR.edge),
      rect(
        Math.round(W * 0.3),
        Math.round(D * 0.3),
        Math.round(W * 0.4),
        Math.round(D * 0.4),
        COLOUR.dark,
        COLOUR.accent,
      ),
    ];
  },
  'injection-moulder-80t': (W, D) => [
    ...housing(W, D, COLOUR.blueGrey, COLOUR.blueGreyTop),
    rect(
      Math.round(W * 0.04),
      Math.round(D * 0.15),
      Math.round(W * 0.3),
      Math.round(D * 0.7),
      COLOUR.steel,
      COLOUR.edge,
    ),
    rect(
      Math.round(W * 0.38),
      Math.round(D * 0.38),
      Math.round(W * 0.5),
      Math.round(D * 0.24),
      COLOUR.steelTop,
      COLOUR.edge,
    ),
    circle(
      Math.round(W * 0.7),
      Math.round(D * 0.5),
      Math.round(D * 0.2),
      COLOUR.accent,
      COLOUR.edge,
    ),
    frontPanel(W, D),
  ],
  'gas-curing-oven': (W, D) => [
    ...housing(W, D, COLOUR.oven, COLOUR.ovenTop),
    line(
      Math.round(W / 2),
      Math.round(D * 0.1),
      Math.round(W / 2),
      Math.round(D * 0.9),
      COLOUR.edge,
    ),
    line(
      Math.round(W * 0.1),
      Math.round(D / 3),
      Math.round(W * 0.9),
      Math.round(D / 3),
      COLOUR.oven,
    ),
    line(
      Math.round(W * 0.1),
      Math.round((D * 2) / 3),
      Math.round(W * 0.9),
      Math.round((D * 2) / 3),
      COLOUR.oven,
    ),
    circle(
      Math.round(W * 0.85),
      Math.round(D * 0.15),
      Math.round(Math.min(W, D) * 0.06),
      COLOUR.dark,
      COLOUR.edge,
    ),
  ],
  'air-compressor-7kw': (W, D) => [
    ...housing(W, D, COLOUR.dark, COLOUR.machineGreen),
    rect(
      Math.round(W * 0.08),
      Math.round(D * 0.15),
      Math.round(W * 0.84),
      Math.round(D * 0.7),
      COLOUR.machineGreenTop,
      COLOUR.edge,
    ),
    circle(Math.round(W * 0.3), Math.round(D / 2), Math.round(D * 0.22), COLOUR.steel, COLOUR.edge),
    rect(
      Math.round(W * 0.55),
      Math.round(D * 0.3),
      Math.round(W * 0.3),
      Math.round(D * 0.4),
      COLOUR.blueGrey,
      COLOUR.edge,
    ),
  ],
  'belt-conveyor-3m': (W, D) => {
    const rail = Math.max(30, Math.round(D * 0.1));
    const rollers: ArtPrimitive[] = [];
    for (let u = 250; u < W; u += 250) {
      rollers.push(line(u, rail, u, D - rail, COLOUR.dark));
    }
    return [
      rect(0, 0, W, D, COLOUR.steel, COLOUR.edge),
      rect(0, rail, W, D - 2 * rail, COLOUR.rubber),
      ...rollers,
    ];
  },
  'pallet-racking-bay': (W, D) => {
    const post = Math.max(60, Math.round(Math.min(W, D) * 0.08));
    const beam = Math.max(40, Math.round(D * 0.06));
    return [
      rect(0, 0, W, D, 0x8b8e8a, COLOUR.edge),
      rect(0, 0, W, beam, COLOUR.rackBeam),
      rect(0, D - beam, W, beam, COLOUR.rackBeam),
      line(Math.round(W / 2), beam, Math.round(W / 2), D - beam, COLOUR.dark),
      rect(0, 0, post, post, COLOUR.rack),
      rect(W - post, 0, post, post, COLOUR.rack),
      rect(0, D - post, post, post, COLOUR.rack),
      rect(W - post, D - post, post, post, COLOUR.rack),
    ];
  },
  'steel-shelving': (W, D) => {
    const post = Math.max(30, Math.round(Math.min(W, D) * 0.08));
    return [
      rect(0, 0, W, D, COLOUR.steelTop, COLOUR.edge),
      line(Math.round(W / 3), 0, Math.round(W / 3), D, COLOUR.steel),
      line(Math.round((W * 2) / 3), 0, Math.round((W * 2) / 3), D, COLOUR.steel),
      rect(0, 0, post, post, COLOUR.dark),
      rect(W - post, 0, post, post, COLOUR.dark),
      rect(0, D - post, post, post, COLOUR.dark),
      rect(W - post, D - post, post, post, COLOUR.dark),
    ];
  },
  'office-desk': (W, D) => [
    ...housing(W, D, COLOUR.wood, COLOUR.woodTop),
    rect(
      Math.round(W * 0.35),
      Math.round(D * 0.12),
      Math.round(W * 0.3),
      Math.round(D * 0.12),
      COLOUR.dark,
    ),
    rect(
      Math.round(W * 0.36),
      Math.round(D * 0.55),
      Math.round(W * 0.28),
      Math.round(D * 0.14),
      COLOUR.panel,
    ),
    rect(
      Math.round(W * 0.72),
      Math.round(D * 0.35),
      Math.round(W * 0.16),
      Math.round(D * 0.3),
      COLOUR.paper,
    ),
  ],
  'filing-cabinet': (W, D) => [
    ...housing(W, D, COLOUR.steel, COLOUR.steelTop),
    line(
      Math.round(W * 0.1),
      Math.round(D * 0.88),
      Math.round(W * 0.9),
      Math.round(D * 0.88),
      COLOUR.dark,
    ),
  ],
};

const BY_CATEGORY: Record<string, Drawing> = {
  machining: (W, D) => [
    ...housing(W, D, COLOUR.machineGreen, COLOUR.machineGreenTop),
    frontPanel(W, D),
  ],
  storage: (W, D) => [rect(0, 0, W, D, COLOUR.steelTop, COLOUR.edge)],
  office: (W, D) => housing(W, D, COLOUR.wood, COLOUR.woodTop),
};

/** The type's drawing in its own frame (orientation 0, origin at the footprint's corner). */
export function equipmentArt(type: ArtType): ArtPrimitive[] {
  const W = type.widthMm;
  const D = type.depthMm;
  const drawing =
    BY_TYPE[type.id] ??
    BY_CATEGORY[type.category] ??
    ((w: number, d: number) => [
      ...housing(w, d, COLOUR.blueGrey, COLOUR.blueGreyTop),
      frontPanel(w, d),
    ]);
  return drawing(W, D);
}

/** A point of the type's frame on the plan, by the domain's clockwise quarter turn. */
function mapPoint(W: number, D: number, rotation: number, u: number, v: number) {
  switch (rotation) {
    case 90:
      return { x: D - v, y: u };
    case 180:
      return { x: W - u, y: D - v };
    case 270:
      return { x: v, y: W - u };
    default:
      return { x: u, y: v };
  }
}

/**
 * Place a drawing on the plan: turned by the item's quarter turn and moved
 * to its footprint's corner. Integer frame coordinates give integer plan
 * coordinates, so the housing lands exactly on the footprint.
 */
export function placeArt(
  art: readonly ArtPrimitive[],
  type: Pick<ArtType, 'widthMm' | 'depthMm'>,
  footprint: RectView,
  rotation: number,
): ArtPrimitive[] {
  const W = type.widthMm;
  const D = type.depthMm;
  const at = (u: number, v: number) => {
    const point = mapPoint(W, D, rotation, u, v);
    return { x: footprint.x + point.x, y: footprint.y + point.y };
  };
  return art.map((primitive): ArtPrimitive => {
    switch (primitive.kind) {
      case 'rect': {
        const a = at(primitive.x, primitive.y);
        const b = at(primitive.x + primitive.width, primitive.y + primitive.depth);
        return {
          ...primitive,
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x),
          depth: Math.abs(b.y - a.y),
        };
      }
      case 'circle': {
        const c = at(primitive.cx, primitive.cy);
        return { ...primitive, cx: c.x, cy: c.y };
      }
      case 'line': {
        const a = at(primitive.x1, primitive.y1);
        const b = at(primitive.x2, primitive.y2);
        return { ...primitive, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      }
    }
  });
}

/** The extent of a drawing: the smallest rectangle holding every primitive. */
export function artBounds(art: readonly ArtPrimitive[]): RectView | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x0: number, y0: number, x1: number, y1: number) => {
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  };
  for (const primitive of art) {
    switch (primitive.kind) {
      case 'rect':
        take(
          primitive.x,
          primitive.y,
          primitive.x + primitive.width,
          primitive.y + primitive.depth,
        );
        break;
      case 'circle':
        take(
          primitive.cx - primitive.r,
          primitive.cy - primitive.r,
          primitive.cx + primitive.r,
          primitive.cy + primitive.r,
        );
        break;
      case 'line':
        take(
          Math.min(primitive.x1, primitive.x2),
          Math.min(primitive.y1, primitive.y2),
          Math.max(primitive.x1, primitive.x2),
          Math.max(primitive.y1, primitive.y2),
        );
        break;
    }
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, depth: maxY - minY }
    : null;
}
