import type { ArtPrimitive } from './equipment-art';

/**
 * Overhead art for load units (spec §3.3, §5.3; D11, ADR-0044; plan Step 10):
 * newly authored procedural vector art, drawn in the container's own frame
 * (width along x, depth along y) and mapped onto its footprint by the same
 * quarter-turn mapping as equipment. The first primitive is always the
 * container's outline, exactly its footprint, and everything lies inside
 * it, so the drawn extent equals the physical footprint. Shading is flat and
 * neutral: no side faces and no shadows.
 *
 * A loaded platform (pallet, timber bunk) shows its load from above in the
 * colour of the goods (or of the cartons it carries), with seams at the size
 * of the carried units; the count itself is in the record, never invented
 * by the drawing.
 */

export interface StockArtInput {
  readonly kind: string;
  readonly widthMm: number;
  readonly depthMm: number;
  /** The container's own colour (#rrggbb). */
  readonly colour: string;
  /** What is seen on top: the goods' or carried units' colour, or null when empty. */
  readonly loadColour: string | null;
  /** Plan size of the units it carries, for seams across the load; null when it carries none. */
  readonly childMm: { readonly width: number; readonly depth: number } | null;
}

const hex = (colour: string) => Number.parseInt(colour.slice(1), 16);

/** A colour mixed toward black (`amount` < 0) or white (`amount` > 0). */
function shade(colour: number, amount: number): number {
  const channel = (shift: number) => {
    const value = (colour >> shift) & 0xff;
    const target = amount < 0 ? 0 : 255;
    return Math.round(value + (target - value) * Math.abs(amount)) & 0xff;
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function rect(
  x: number,
  y: number,
  width: number,
  depth: number,
  fill: number,
  stroke?: number,
): ArtPrimitive {
  return stroke === undefined
    ? { kind: 'rect', x, y, width, depth, fill }
    : { kind: 'rect', x, y, width, depth, fill, stroke };
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: number): ArtPrimitive {
  return { kind: 'line', x1, y1, x2, y2, stroke };
}

/** Seams across a load at a module, within an inset rectangle. */
function seams(
  x: number,
  y: number,
  width: number,
  depth: number,
  module: { readonly width: number; readonly depth: number },
  stroke: number,
): ArtPrimitive[] {
  const result: ArtPrimitive[] = [];
  if (module.width >= 100) {
    for (let at = x + module.width; at < x + width - 20; at += module.width) {
      result.push(line(at, y, at, y + depth, stroke));
    }
  }
  if (module.depth >= 100) {
    for (let at = y + module.depth; at < y + depth - 20; at += module.depth) {
      result.push(line(x, at, x + width, at, stroke));
    }
  }
  return result;
}

function platform(input: StockArtInput): ArtPrimitive[] {
  const W = input.widthMm;
  const D = input.depthMm;
  const wood = hex(input.colour);
  const art: ArtPrimitive[] = [rect(0, 0, W, D, shade(wood, -0.45), shade(wood, -0.6))];
  if (input.loadColour === null) {
    // Empty: the top deck boards, running across the depth, with gaps between them.
    const boards = Math.max(3, Math.round(W / 175));
    const pitch = W / boards;
    const board = pitch * 0.72;
    for (let n = 0; n < boards; n += 1) {
      art.push(rect(n * pitch + (pitch - board) / 2, 0, board, D, wood, shade(wood, -0.3)));
    }
    return art;
  }
  // Loaded: the top of the load, inset a little from the deck edge.
  const inset = Math.min(15, W / 20, D / 20);
  const load = hex(input.loadColour);
  art.push(rect(inset, inset, W - 2 * inset, D - 2 * inset, load, shade(load, -0.45)));
  const module = input.childMm ?? { width: Math.max(W, D) / 4, depth: 0 };
  art.push(...seams(inset, inset, W - 2 * inset, D - 2 * inset, module, shade(load, -0.35)));
  return art;
}

function carton(input: StockArtInput): ArtPrimitive[] {
  const W = input.widthMm;
  const D = input.depthMm;
  const board = hex(input.colour);
  const tape = shade(board, 0.35);
  const along = W >= D;
  return [
    rect(0, 0, W, D, board, shade(board, -0.45)),
    // The flap seam and its tape along the long side.
    along
      ? rect(0, D / 2 - Math.min(25, D / 10), W, Math.min(50, D / 5), tape)
      : rect(W / 2 - Math.min(25, W / 10), 0, Math.min(50, W / 5), D, tape),
    along
      ? line(0, D / 2, W, D / 2, shade(board, -0.4))
      : line(W / 2, 0, W / 2, D, shade(board, -0.4)),
  ];
}

function crate(input: StockArtInput): ArtPrimitive[] {
  const W = input.widthMm;
  const D = input.depthMm;
  const wood = hex(input.colour);
  const frame = Math.min(70, W / 8, D / 8);
  const art: ArtPrimitive[] = [
    rect(0, 0, W, D, shade(wood, -0.25), shade(wood, -0.55)),
    rect(frame, frame, W - 2 * frame, D - 2 * frame, wood, shade(wood, -0.35)),
  ];
  // Lid boards along the length.
  const boards = Math.max(2, Math.round((D - 2 * frame) / 150));
  const pitch = (D - 2 * frame) / boards;
  for (let n = 1; n < boards; n += 1) {
    const y = frame + n * pitch;
    art.push(line(frame, y, W - frame, y, shade(wood, -0.35)));
  }
  return art;
}

function tote(input: StockArtInput): ArtPrimitive[] {
  const W = input.widthMm;
  const D = input.depthMm;
  const plastic = hex(input.colour);
  const rim = Math.min(25, W / 10, D / 10);
  const art: ArtPrimitive[] = [
    rect(0, 0, W, D, shade(plastic, 0.15), shade(plastic, -0.5)),
    rect(
      rim,
      rim,
      W - 2 * rim,
      D - 2 * rim,
      input.loadColour ? hex(input.loadColour) : shade(plastic, -0.2),
    ),
  ];
  // Hand holds at the two short ends.
  const grip = Math.min(120, W / 4);
  art.push(rect(W / 2 - grip / 2, rim / 4, grip, rim / 2, shade(plastic, -0.4)));
  art.push(rect(W / 2 - grip / 2, D - (rim * 3) / 4, grip, rim / 2, shade(plastic, -0.4)));
  return art;
}

function drum(input: StockArtInput): ArtPrimitive[] {
  const W = input.widthMm;
  const D = input.depthMm;
  const steel = hex(input.colour);
  const r = Math.min(W, D) / 2;
  return [
    // The lid seen from above: a circle exactly inscribed in the footprint.
    { kind: 'circle', cx: W / 2, cy: D / 2, r, fill: steel, stroke: shade(steel, -0.5) },
    {
      kind: 'circle',
      cx: W / 2,
      cy: D / 2,
      r: r * 0.9,
      fill: shade(steel, 0.12),
      stroke: shade(steel, -0.3),
    },
    // The two bungs.
    { kind: 'circle', cx: W / 2 - r * 0.5, cy: D / 2, r: r * 0.09, fill: shade(steel, -0.35) },
    { kind: 'circle', cx: W / 2 + r * 0.55, cy: D / 2, r: r * 0.05, fill: shade(steel, -0.35) },
  ];
}

function bulkBag(input: StockArtInput): ArtPrimitive[] {
  const W = input.widthMm;
  const D = input.depthMm;
  const fabric = hex(input.colour);
  const loop = Math.min(110, W / 8, D / 8);
  const fill = input.loadColour ? hex(input.loadColour) : fabric;
  return [
    rect(0, 0, W, D, shade(fabric, -0.1), shade(fabric, -0.45)),
    rect(loop / 2, loop / 2, W - loop, D - loop, shade(fill, -0.05)),
    // The four lifting loops and the filling spout.
    rect(0, 0, loop, loop, shade(fabric, -0.3)),
    rect(W - loop, 0, loop, loop, shade(fabric, -0.3)),
    rect(0, D - loop, loop, loop, shade(fabric, -0.3)),
    rect(W - loop, D - loop, loop, loop, shade(fabric, -0.3)),
    { kind: 'circle', cx: W / 2, cy: D / 2, r: Math.min(W, D) / 8, fill: shade(fabric, -0.2) },
  ];
}

/** The overhead drawing of a load unit, in its own frame. */
export function stockArt(input: StockArtInput): ArtPrimitive[] {
  switch (input.kind) {
    case 'pallet':
    case 'cart':
      return platform(input);
    case 'carton':
      return carton(input);
    case 'crate':
      return crate(input);
    case 'tote':
      return tote(input);
    case 'drum':
      return drum(input);
    case 'bulk-bag':
      return bulkBag(input);
    default:
      return [rect(0, 0, input.widthMm, input.depthMm, hex(input.colour), 0x202020)];
  }
}
