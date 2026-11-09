import { Rectangle, Texture } from 'pixi.js';
import type { FacilitiesView } from '../../../../shared/ipc/facilities';

/**
 * The floor texture atlas (spec §5.6, §11.3; ADR-0051): one canvas holding,
 * for every floor material, its per-cell texture variants, each a 500 mm
 * cell drawn from directly above at 128 px a metre. The tiles are newly
 * authored procedural placeholders, drawn from each material's own colour
 * and texture family with a fixed seed per (material, variant), so the floor
 * looks the same every time: speckled concrete, stained old slab, faint
 * mottling on polished or painted slab, near-seamless epoxy, brushed steel,
 * diamond tread, anti-slip grit, safety hatching, vinyl and carpet tiles.
 * Shading is even and non-directional. Joints at a material's own module
 * (saw cuts, plate seams, tile edges) are not in the tiles: the floor layer
 * draws them at their real positions, independent of the grid.
 */

const TILE_PX = 64;

type Material = FacilitiesView['floorMaterials'][number];

/** A small deterministic generator for the tile drawings (presentation only). */
function generator(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function seedOf(text: string, variant: number): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return Math.imul(hash ^ (variant + 1), 2654435761);
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function shade([r, g, b]: [number, number, number], amount: number, alpha = 1): string {
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + amount)));
  return `rgba(${f(r)},${f(g)},${f(b)},${alpha})`;
}

/** Dots kept inside the tile so neighbouring cells join without a seam. */
function speckle(
  ctx: CanvasRenderingContext2D,
  random: () => number,
  base: [number, number, number],
  count: number,
  spread: number,
  size = 1,
) {
  for (let index = 0; index < count; index += 1) {
    const x = Math.floor(random() * (TILE_PX - size));
    const y = Math.floor(random() * (TILE_PX - size));
    ctx.fillStyle = shade(base, (random() * 2 - 1) * spread);
    ctx.fillRect(x, y, size, size);
  }
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  material: Material,
  variant: number,
  ox: number,
  oy: number,
) {
  const base = rgb(material.colour);
  const random = generator(seedOf(material.id, variant));
  ctx.save();
  ctx.translate(ox, oy);
  ctx.beginPath();
  ctx.rect(0, 0, TILE_PX, TILE_PX);
  ctx.clip();
  // Every tile starts from the material's own colour, so its average stays true to it.
  ctx.fillStyle = material.colour;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  switch (material.textureSet) {
    case 'concrete':
      speckle(ctx, random, base, 260, 12);
      break;
    case 'concrete-worn':
      // One or two soft, rounded stains; kept faint so cells do not read as tiles.
      for (let index = 0; index < 1 + Math.floor(random() * 2); index += 1) {
        ctx.fillStyle = shade(base, -14, 0.1);
        const rx = 6 + random() * 12;
        const ry = rx * (0.5 + random() / 2);
        ctx.beginPath();
        ctx.ellipse(
          rx + 2 + random() * (TILE_PX - 2 * rx - 4),
          ry + 2 + random() * (TILE_PX - 2 * ry - 4),
          rx,
          ry,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      speckle(ctx, random, base, 320, 16);
      break;
    case 'concrete-polished':
    case 'painted-concrete':
      speckle(ctx, random, base, 90, 6, 2);
      break;
    case 'epoxy':
    case 'anti-slip':
      speckle(
        ctx,
        random,
        base,
        material.textureSet === 'epoxy' ? 40 : 600,
        material.textureSet === 'epoxy' ? 4 : 14,
      );
      break;
    case 'steel-plate':
      for (let y = 0; y < TILE_PX; y += 2) {
        ctx.fillStyle = shade(base, (random() * 2 - 1) * 6, 0.6);
        ctx.fillRect(0, y, TILE_PX, 1);
      }
      break;
    case 'diamond-plate':
      // Tread lugs on an 8 px lattice (62.5 mm), alternating direction; 8 divides the tile.
      for (let y = 0; y < TILE_PX; y += 8) {
        for (let x = 0; x < TILE_PX; x += 8) {
          ctx.fillStyle = shade(base, 22);
          const flip = ((x + y) / 8) % 2 === 0;
          ctx.fillRect(x + (flip ? 1 : 3), y + (flip ? 3 : 1), flip ? 6 : 2, flip ? 2 : 6);
        }
      }
      break;
    case 'safety-hatching': {
      // 45° bands with a period that divides the tile, so they run on across cells.
      ctx.fillStyle = '#2b2a26';
      const period = 32;
      for (let k = -TILE_PX; k < TILE_PX * 2; k += period) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k + period / 2, 0);
        ctx.lineTo(k + period / 2 - TILE_PX, TILE_PX);
        ctx.lineTo(k - TILE_PX, TILE_PX);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'vinyl-tile':
      ctx.fillStyle = shade(base, (variant - 1.5) * 4);
      ctx.fillRect(0, 0, TILE_PX, TILE_PX);
      speckle(ctx, random, base, 70, 8, 2);
      break;
    case 'carpet-tile':
      speckle(ctx, random, base, 900, 10);
      break;
    default:
      speckle(ctx, random, base, 120, 8);
  }
  ctx.restore();
}

export interface FloorAtlas {
  /** A material's variant texture; every material has at least one. */
  frame(materialId: string, variant: number): Texture | null;
  variantsOf(materialId: string): number;
  destroy(): void;
}

export function createFloorAtlas(materials: FacilitiesView['floorMaterials']): FloorAtlas {
  const columns = Math.max(1, ...materials.map((material) => material.textureVariants));
  const canvas = document.createElement('canvas');
  canvas.width = columns * TILE_PX;
  canvas.height = Math.max(1, materials.length) * TILE_PX;
  const ctx = canvas.getContext('2d');
  const frames = new Map<string, Texture[]>();
  if (!ctx) {
    return { frame: () => null, variantsOf: () => 1, destroy: () => undefined };
  }
  materials.forEach((material, row) => {
    for (let variant = 0; variant < material.textureVariants; variant += 1) {
      drawTile(ctx, material, variant, variant * TILE_PX, row * TILE_PX);
    }
  });
  const source = Texture.from(canvas).source;
  materials.forEach((material, row) => {
    const list: Texture[] = [];
    for (let variant = 0; variant < material.textureVariants; variant += 1) {
      list.push(
        new Texture({
          source,
          frame: new Rectangle(variant * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX),
        }),
      );
    }
    frames.set(material.id, list);
  });
  return {
    frame: (materialId, variant) => {
      const list = frames.get(materialId);
      return list?.[variant % list.length] ?? null;
    },
    variantsOf: (materialId) => frames.get(materialId)?.length ?? 1,
    destroy: () => {
      for (const list of frames.values()) {
        for (const texture of list) {
          texture.destroy(false);
        }
      }
      source.destroy();
    },
  };
}
