import { Container, Graphics, RenderTexture, Sprite, type Renderer } from 'pixi.js';
import type { FacilitiesView } from '../../../../shared/ipc/facilities';
import type { WorldRect } from '../camera';
import {
  buildFloorModel,
  cellVariant,
  chunkRect,
  chunkRuns,
  dirtyChunks,
  floorDetail,
  patternLines,
  visibleChunks,
  type ChunkKey,
  type FloorDetail,
  type FloorModel,
} from '../floor-model';
import type { SceneFrame } from '../scene-model';
import { GRID_MM } from '../../plan-transform';
import { Pool } from '../pool';
import { createFloorAtlas, type FloorAtlas } from './floor-atlas';

/**
 * The floor layer (spec §5.6, §11.3; ADR-0046, ADR-0051). Each chunk of
 * 16 × 16 cells is drawn once into its own texture at the current zoom and
 * shown as one sprite, so the scene holds one display object per *visible*
 * chunk, whatever the number of cells. A chunk is redrawn only when one of
 * its cells' coverings changes (a dirty chunk) or the zoom step changes;
 * panning shows cached chunks and culls the rest. Zoomed out, a cell is its
 * material's flat colour; zoomed in, its texture variant from the atlas,
 * chosen by a fixed hash of its coordinates. A material's own joints are
 * drawn at their real module, continuous across cells and chunks. The
 * layer never draws anything but coverings: objects live elsewhere.
 */

/** Chunk textures kept for chunks scrolled out of view, before the oldest is freed. */
const SPARE_TEXTURES = 96;
/** Joints are drawn only when they are at least this far apart on screen. */
const MIN_JOINT_SPACING_PX = 6;

interface CachedChunk {
  readonly texture: RenderTexture;
  readonly pixelsPerMetre: number;
  readonly detail: FloorDetail;
  sprite: Sprite | null;
}

type Materials = FacilitiesView['floorMaterials'];

export class FloorLayer {
  readonly container = new Container({ label: 'floor' });
  readonly #renderer: Renderer;
  readonly #sprites = new Pool<Sprite>(
    () => new Sprite(),
    (sprite) => {
      sprite.removeFromParent();
      sprite.visible = false;
    },
  );
  readonly #cellSprites = new Pool<Sprite>(
    () => new Sprite(),
    (sprite) => {
      sprite.removeFromParent();
    },
  );
  readonly #chunks = new Map<ChunkKey, CachedChunk>();
  #model: FloorModel | null = null;
  #modelSource: unknown = null;
  #sourceKey = '';
  #materials: Materials = [];
  #atlas: FloorAtlas | null = null;
  #redraws = 0;
  #visible = 0;
  #detail: FloorDetail = 'flat';

  constructor(renderer: Renderer) {
    this.#renderer = renderer;
  }

  get model(): FloorModel | null {
    return this.#model;
  }

  get redraws(): number {
    return this.#redraws;
  }

  get visibleCount(): number {
    return this.#visible;
  }

  get detail(): FloorDetail {
    return this.#detail;
  }

  /** Bring the layer up to date with a frame and a camera view. */
  update(frame: SceneFrame, view: WorldRect, pixelsPerMetre: number): void {
    if (frame.materials !== this.#materials) {
      this.#atlas?.destroy();
      this.#atlas = createFloorAtlas(frame.materials);
      this.#materials = frame.materials;
      this.#invalidateAll();
    }
    const source = `${frame.surfaceMaterialId}|${frame.level.index}`;
    if (frame.level !== this.#modelSource || this.#model === null) {
      const next = buildFloorModel(
        frame.level,
        frame.surfaceMaterialId,
        frame.materials.map((material) => material.id),
      );
      const sameGrid =
        this.#model !== null &&
        this.#model.cols === next.cols &&
        this.#model.rows === next.rows &&
        this.#sourceKey === source;
      if (sameGrid) {
        for (const key of dirtyChunks(this.#model, next)) {
          this.#invalidate(key);
        }
      } else {
        this.#invalidateAll();
      }
      this.#model = next;
      this.#modelSource = frame.level;
      this.#sourceKey = source;
    }
    const model = this.#model;
    this.#detail = floorDetail(pixelsPerMetre);
    const wanted = new Set(visibleChunks(model, view));
    // Cull: chunks out of view give their sprite back but keep their texture for a while.
    for (const [key, chunk] of this.#chunks) {
      if (!wanted.has(key) && chunk.sprite) {
        this.#sprites.release(chunk.sprite);
        chunk.sprite = null;
      }
    }
    for (const key of wanted) {
      let chunk = this.#chunks.get(key);
      if (chunk && (chunk.pixelsPerMetre !== pixelsPerMetre || chunk.detail !== this.#detail)) {
        this.#invalidate(key);
        chunk = undefined;
      }
      if (!chunk) {
        chunk = this.#draw(model, key, pixelsPerMetre);
        this.#chunks.set(key, chunk);
      }
      if (!chunk.sprite) {
        const sprite = this.#sprites.acquire();
        const rect = chunkRect(model, key);
        sprite.texture = chunk.texture;
        sprite.position.set(rect.x, rect.y);
        // The texture is whole pixels at this zoom; size it back to millimetres so it maps 1:1.
        const scale = pixelsPerMetre / 1000;
        sprite.setSize(chunk.texture.width / scale, chunk.texture.height / scale);
        sprite.visible = true;
        sprite.label = `floor-chunk ${key}`;
        this.container.addChild(sprite);
        chunk.sprite = sprite;
      }
    }
    this.#visible = wanted.size;
    this.#trimSpares(wanted);
  }

  #invalidate(key: ChunkKey): void {
    const chunk = this.#chunks.get(key);
    if (!chunk) {
      return;
    }
    if (chunk.sprite) {
      this.#sprites.release(chunk.sprite);
    }
    chunk.texture.destroy(true);
    this.#chunks.delete(key);
  }

  #invalidateAll(): void {
    for (const key of [...this.#chunks.keys()]) {
      this.#invalidate(key);
    }
  }

  #trimSpares(wanted: Set<ChunkKey>): void {
    let spare = this.#chunks.size - wanted.size;
    for (const key of this.#chunks.keys()) {
      if (spare <= SPARE_TEXTURES) {
        return;
      }
      if (!wanted.has(key)) {
        this.#invalidate(key);
        spare -= 1;
      }
    }
  }

  /** Draw one chunk into a texture of whole pixels at this zoom. */
  #draw(model: FloorModel, key: ChunkKey, pixelsPerMetre: number): CachedChunk {
    this.#redraws += 1;
    const scale = pixelsPerMetre / 1000;
    const rect = chunkRect(model, key);
    const texture = RenderTexture.create({
      width: Math.max(1, Math.ceil(rect.width * scale)),
      height: Math.max(1, Math.ceil(rect.depth * scale)),
      resolution: this.#renderer.resolution,
      antialias: false,
    });
    const content = new Container();
    content.scale.set(scale);
    content.position.set(-rect.x * scale, -rect.y * scale);
    const runs = chunkRuns(model, key);
    const used: Sprite[] = [];
    const temporary: Graphics[] = [];
    const detail = floorDetail(pixelsPerMetre);
    const byId = new Map(this.#materials.map((material) => [material.id, material]));
    if (detail === 'flat') {
      const flat = new Graphics();
      for (const [col, row, length, index] of runs) {
        const colour = byId.get(model.materials[index] ?? '')?.colour ?? '#808080';
        flat.rect(col * GRID_MM, row * GRID_MM, length * GRID_MM, GRID_MM).fill(colour);
      }
      content.addChild(flat);
      temporary.push(flat);
    } else {
      for (const [col, row, length, index] of runs) {
        const id = model.materials[index] ?? '';
        const variants = this.#atlas?.variantsOf(id) ?? 1;
        for (let c = col; c < col + length; c += 1) {
          const frame = this.#atlas?.frame(id, cellVariant(c, row, variants));
          const sprite = this.#cellSprites.acquire();
          sprite.texture = frame ?? sprite.texture;
          sprite.position.set(c * GRID_MM, row * GRID_MM);
          sprite.setSize(GRID_MM, GRID_MM);
          content.addChild(sprite);
          used.push(sprite);
        }
      }
    }
    // Each material's own joints, at its module from the level origin.
    const joints = new Graphics();
    temporary.push(joints);
    for (const [col, row, length, index] of runs) {
      const material = byId.get(model.materials[index] ?? '');
      if (!material) {
        continue;
      }
      const spacing = Math.min(material.patternMm.x, material.patternMm.y) * scale;
      if (spacing < MIN_JOINT_SPACING_PX) {
        continue;
      }
      const run = { x: col * GRID_MM, y: row * GRID_MM, width: length * GRID_MM, depth: GRID_MM };
      const lines = patternLines(run, material.patternMm);
      for (const x of lines.xs) {
        if (x < run.x + run.width) {
          joints.moveTo(x, run.y).lineTo(x, run.y + run.depth);
        }
      }
      for (const y of lines.ys) {
        if (y < run.y + run.depth) {
          joints.moveTo(run.x, y).lineTo(run.x + run.width, y);
        }
      }
    }
    joints.stroke({ color: 0x000000, alpha: 0.22, width: 1, pixelLine: true });
    content.addChild(joints);
    this.#renderer.render({ container: content, target: texture, clear: true });
    for (const sprite of used) {
      this.#cellSprites.release(sprite);
    }
    for (const child of temporary) {
      child.destroy();
    }
    content.destroy({ children: false });
    return { texture, pixelsPerMetre, detail, sprite: null };
  }

  destroy(): void {
    this.#invalidateAll();
    this.#sprites.drain((sprite) => {
      sprite.destroy();
    });
    this.#cellSprites.drain((sprite) => {
      sprite.destroy();
    });
    this.#atlas?.destroy();
    this.container.destroy({ children: true });
  }
}
