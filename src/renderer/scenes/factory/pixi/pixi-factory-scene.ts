// PixiJS v8 compiles shaders with `new Function` unless this polyfill is
// loaded first; the renderer's CSP forbids eval (ADR-0008, ADR-0051).
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import type { QueryResult, RectView } from '../../../../shared/ipc/facilities';
import {
  cameraTransform,
  pixelsPerMetreOf,
  visibleWorldRect,
  worldToScreen,
  type Camera,
  type ViewportSize,
} from '../camera';
import { equipmentArt, placeArt, type ArtPrimitive } from '../equipment-art';
import { diffScene, type SceneFrame, type SceneModel, type SceneObject } from '../scene-model';
import type { FactoryScene, ScreenRect, SceneStats } from '../scene-port';
import { GRID_MM, LATTICE_MM } from '../../plan-transform';
import { Pool } from '../pool';
import { FloorLayer } from './floor-layer';

/**
 * The PixiJS factory scene (spec §3.3, §11.3; DECISIONS ADR-0044, ADR-0046,
 * ADR-0051). One world container carries the whole level in millimetres;
 * the camera sets its uniform scale and translation and nothing else, so
 * every mode draws the same physical coordinates through the same
 * orthographic, north-up projection. Layers, bottom to top:
 *
 * 1. floor coverings (chunked, cached, culled; `FloorLayer`), masked to the outline;
 * 2. structure: columns, walls, obstacles, forbidden zones, the outline wall and doors;
 * 3. the construction grid and sub-grid (layout mode), masked to the outline;
 * 4. zones: keep-clear landings and each item's operator, maintenance, clearance and port zones;
 * 5. equipment, one pooled sprite per item keyed by its entity id, in layer-and-height order;
 * 6. presentation: operational state lamps, selection, hover, the placement preview
 *    and, in a screen-space layer, labels and inspection measurements.
 *
 * Frames are drawn on demand (no ticker): nothing moves until Step 12, and a
 * frame only redraws what its diff changed. The scene reads the frame and
 * never writes anything back.
 */

const COLOURS = {
  slab: 0x6d6c66,
  wall: 0x2a2a2a,
  column: 0x4a4a48,
  obstacle: 0x7a756a,
  forbidden: 0xa0281e,
  keepClear: 0x3d6b3d,
  grid: 0x1e3440,
  zone: 0x3c6e8c,
  port: 0x9a7a28,
  selection: 0xf0c040,
  hover: 0xf2f2ee,
  allowed: 0x46a046,
  refused: 0xb03c28,
  problem: 0xdc2814,
  idle: 0xc9b458,
  label: 0xf2f2ee,
  door: { personnel: 0x2f6f2f, 'roller-shutter': 0x1f3a5a, 'loading-dock': 0x8b4a00 },
} as const;

const LABEL_FROM_PIXELS_PER_METRE = 20;
const LABEL_STYLE = {
  fontFamily: 'Tahoma, Verdana, sans-serif',
  fontSize: 11,
  fill: COLOURS.label,
  stroke: { color: 0x101010, width: 3 },
} as const;

interface ObjectSprite {
  readonly container: Container;
  readonly art: Graphics;
  id: string;
  redraws: number;
}

/**
 * Draw placed art. Hairlines are inner-aligned, so PixiJS adds nothing outside
 * the shapes and the sprite's drawn extent is exactly its footprint.
 */
function drawArt(graphics: Graphics, art: readonly ArtPrimitive[]): void {
  graphics.clear();
  for (const primitive of art) {
    switch (primitive.kind) {
      case 'rect':
        graphics
          .rect(primitive.x, primitive.y, primitive.width, primitive.depth)
          .fill(primitive.fill);
        if (primitive.stroke !== undefined) {
          graphics.stroke({ color: primitive.stroke, width: 1, pixelLine: true, alignment: 1 });
        }
        break;
      case 'circle':
        graphics.circle(primitive.cx, primitive.cy, primitive.r).fill(primitive.fill);
        if (primitive.stroke !== undefined) {
          graphics.stroke({ color: primitive.stroke, width: 1, pixelLine: true, alignment: 1 });
        }
        break;
      case 'line':
        graphics
          .moveTo(primitive.x1, primitive.y1)
          .lineTo(primitive.x2, primitive.y2)
          .stroke({ color: primitive.stroke, width: 1, pixelLine: true, alignment: 1 });
        break;
    }
  }
}

function rectPath(graphics: Graphics, rect: RectView): Graphics {
  return graphics.rect(rect.x, rect.y, rect.width, rect.depth);
}

export async function createPixiFactoryScene(host: HTMLElement): Promise<FactoryScene> {
  const app = new Application();
  await app.init({
    preference: 'webgl',
    width: Math.max(1, host.clientWidth),
    height: Math.max(1, host.clientHeight),
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    autoStart: false,
    sharedTicker: false,
    // Read back for the probe and screenshots; frames are drawn on demand, so this costs nothing per tick.
    preserveDrawingBuffer: true,
  });
  app.ticker.stop();
  const canvas = app.canvas;
  canvas.className = 'factory-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  app.stage.eventMode = 'none';

  const world = new Container({ label: 'world' });
  const screen = new Container({ label: 'screen' });
  app.stage.addChild(world, screen);

  const slab = new Graphics({ label: 'slab' });
  const floor = new FloorLayer(app.renderer);
  const floorMask = new Graphics();
  const structure = new Graphics({ label: 'structure' });
  const doors = new Graphics({ label: 'doors' });
  const grid = new Graphics({ label: 'grid' });
  const gridMask = new Graphics();
  const zones = new Graphics({ label: 'zones' });
  const objects = new Container({ label: 'objects', sortableChildren: false });
  const lamps = new Graphics({ label: 'state' });
  const marks = new Graphics({ label: 'selection' });
  const preview = new Graphics({ label: 'preview' });
  floor.container.mask = floorMask;
  grid.mask = gridMask;
  world.addChild(
    slab,
    floor.container,
    floorMask,
    structure,
    doors,
    grid,
    gridMask,
    zones,
    objects,
    lamps,
    marks,
    preview,
  );

  const labels = new Container({ label: 'labels' });
  screen.addChild(labels);
  const labelPool = new Pool<Text>(
    () => new Text({ text: '', style: LABEL_STYLE, resolution: window.devicePixelRatio || 1 }),
    (text) => {
      text.removeFromParent();
    },
  );
  const usedLabels: Text[] = [];

  const spritePool = new Pool<ObjectSprite>(
    () => {
      const container = new Container();
      const art = new Graphics();
      container.addChild(art);
      return { container, art, id: '', redraws: 0 };
    },
    (sprite) => {
      sprite.container.removeFromParent();
      sprite.art.clear();
      sprite.id = '';
      sprite.redraws = 0;
    },
  );
  const sprites = new Map<string, ObjectSprite>();
  let objectRedraws = 0;

  let scene: SceneModel | null = null;
  let level: SceneFrame['level'] | null = null;
  let structureKey = '';
  let gridKey = '';
  let frames = 0;
  let lastCamera: Camera | null = null;
  let lastViewport: ViewportSize = { width: 0, height: 0 };
  let destroyed = false;

  const drawStructure = (frame: SceneFrame, ppm: number) => {
    const key = `${frame.level.index}|${ppm}|${frame.level.floor.map((p) => `${p.x},${p.y}`).join(' ')}|${JSON.stringify(frame.level.features)}`;
    if (key === structureKey && frame.level === level) {
      return;
    }
    structureKey = key;
    const px = (n: number) => (n * 1000) / ppm;
    const points = frame.level.floor.flatMap((corner) => [corner.x, corner.y]);
    slab.clear().poly(points).fill(COLOURS.slab);
    floorMask.clear().poly(points).fill(0xffffff);
    gridMask.clear().poly(points).fill(0xffffff);
    structure.clear();
    for (const object of frame.scene.objects) {
      if (object.kind !== 'feature') {
        continue;
      }
      switch (object.feature) {
        case 'forbidden':
          rectPath(structure, object.rect)
            .fill({ color: COLOURS.forbidden, alpha: 0.18 })
            .stroke({ color: COLOURS.forbidden, width: 1, pixelLine: true });
          break;
        case 'obstacle':
          rectPath(structure, object.rect)
            .fill(COLOURS.obstacle)
            .stroke({ color: 0x3a3a3a, width: 1, pixelLine: true });
          break;
        default:
          rectPath(structure, object.rect)
            .fill(object.feature === 'wall' ? COLOURS.wall : COLOURS.column)
            .stroke({ color: COLOURS.wall, width: 1, pixelLine: true });
      }
    }
    structure.poly(points).stroke({ color: COLOURS.wall, width: px(3), alignment: 0 });
    doors.clear();
    for (const object of frame.scene.objects) {
      if (object.kind === 'door') {
        doors
          .moveTo(object.x1, object.y1)
          .lineTo(object.x2, object.y2)
          .stroke({ color: COLOURS.door[object.door], width: px(5), cap: 'butt' });
      }
    }
  };

  const drawGrid = (frame: SceneFrame, ppm: number) => {
    const show = frame.showGrid || frame.showSubGrid;
    grid.visible = show;
    const { bounds } = frame.level;
    const key = `${frame.level.index}|${bounds.width}|${bounds.depth}|${frame.showGrid}|${frame.showSubGrid}|${ppm}`;
    if (!show || key === gridKey) {
      return;
    }
    gridKey = key;
    grid.clear();
    const right = Math.ceil((bounds.x + bounds.width) / GRID_MM) * GRID_MM;
    const bottom = Math.ceil((bounds.y + bounds.depth) / GRID_MM) * GRID_MM;
    const lines = (step: number) => {
      for (let x = 0; x <= right; x += step) {
        grid.moveTo(x, 0).lineTo(x, bottom);
      }
      for (let y = 0; y <= bottom; y += step) {
        grid.moveTo(0, y).lineTo(right, y);
      }
    };
    // Fainter as the cells shrink on screen, so the floor stays legible; always on exact boundaries.
    const spacing = (GRID_MM * ppm) / 1000;
    if (frame.showSubGrid) {
      lines(LATTICE_MM);
      grid.stroke({
        color: COLOURS.grid,
        alpha: Math.min(0.2, spacing / 40),
        width: 1,
        pixelLine: true,
      });
    }
    if (frame.showGrid) {
      lines(GRID_MM);
      grid.stroke({
        color: COLOURS.grid,
        alpha: Math.min(0.45, spacing / 12),
        width: 1,
        pixelLine: true,
      });
    }
  };

  const drawZones = (frame: SceneFrame) => {
    zones.clear();
    zones.visible = frame.mode !== 'operating';
    if (!zones.visible) {
      return;
    }
    for (const object of frame.scene.objects) {
      if (object.kind === 'keep-clear') {
        rectPath(zones, object.rect)
          .fill({ color: COLOURS.keepClear, alpha: 0.12 })
          .stroke({ color: COLOURS.keepClear, width: 1, pixelLine: true });
      } else if (object.kind === 'equipment') {
        for (const zone of object.zones) {
          const port = zone.kind === 'input' || zone.kind === 'output';
          const colour = port ? COLOURS.port : COLOURS.zone;
          rectPath(zones, zone.rect)
            .fill({ color: colour, alpha: 0.16 })
            .stroke({ color: colour, alpha: 0.6, width: 1, pixelLine: true });
        }
      }
    }
  };

  const applyObjects = (next: SceneModel) => {
    const diff = diffScene(scene, next);
    for (const id of diff.removed) {
      const sprite = sprites.get(id);
      if (sprite) {
        spritePool.release(sprite);
        sprites.delete(id);
      }
    }
    for (const object of [...diff.added, ...diff.changed]) {
      if (object.kind !== 'equipment') {
        continue;
      }
      let sprite = sprites.get(object.id);
      if (!sprite) {
        sprite = spritePool.acquire();
        sprite.id = object.id;
        sprite.container.label = object.id;
        sprites.set(object.id, sprite);
      }
      const art = placeArt(
        equipmentArt({
          id: object.typeId,
          category: object.category,
          widthMm: object.widthMm,
          depthMm: object.depthMm,
        }),
        { widthMm: object.widthMm, depthMm: object.depthMm },
        object.rect,
        object.rotation,
      );
      drawArt(sprite.art, art);
      sprite.redraws += 1;
      objectRedraws += 1;
    }
    if (diff.reordered || diff.added.length > 0) {
      // Restack in drawing order: layer, then height above the floor (never screen y).
      objects.removeChildren();
      for (const object of next.objects) {
        const sprite = sprites.get(object.id);
        if (sprite) {
          objects.addChild(sprite.container);
        }
      }
    }
    scene = next;
  };

  const drawPresentation = (frame: SceneFrame, camera: Camera, viewport: ViewportSize) => {
    const ppm = pixelsPerMetreOf(camera);
    const px = (n: number) => (n * 1000) / ppm;
    const equipment = frame.scene.objects.filter(
      (object): object is Extract<SceneObject, { kind: 'equipment' }> =>
        object.kind === 'equipment',
    );
    // Operational state: a small lamp in each item's corner (idle until production, Step 13).
    lamps.clear();
    lamps.visible = frame.mode !== 'layout';
    if (lamps.visible) {
      for (const object of equipment) {
        const r = Math.min(px(4), object.rect.width / 4, object.rect.depth / 4);
        lamps
          .circle(object.rect.x + r * 1.5, object.rect.y + r * 1.5, r)
          .fill(COLOURS.idle)
          .stroke({ color: 0x101010, width: 1, pixelLine: true });
      }
    }
    marks.clear();
    for (const object of equipment) {
      if (object.id === frame.selectedId) {
        rectPath(marks, object.rect).stroke({
          color: COLOURS.selection,
          width: px(2),
          alignment: 1,
        });
      } else if (object.id === frame.hoverId) {
        rectPath(marks, object.rect).stroke({ color: COLOURS.hover, width: 1, pixelLine: true });
      }
    }
    drawPreview(frame.preview);
    // Labels, in screen space so text stays crisp at every zoom.
    for (const text of usedLabels.splice(0)) {
      labelPool.release(text);
    }
    if (ppm >= LABEL_FROM_PIXELS_PER_METRE || frame.mode === 'inspection') {
      for (const object of equipment) {
        const centre = worldToScreen(
          camera,
          viewport,
          object.rect.x + object.rect.width / 2,
          object.rect.y + object.rect.depth / 2,
        );
        const text = labelPool.acquire();
        text.text =
          frame.mode === 'inspection'
            ? `${object.name}\n${object.rect.width.toLocaleString('en-US')} × ${object.rect.depth.toLocaleString('en-US')} mm · idle`
            : object.name;
        text.style.align = 'center';
        text.anchor.set(0.5);
        text.position.set(Math.round(centre.x), Math.round(centre.y));
        labels.addChild(text);
        usedLabels.push(text);
      }
    }
  };

  const drawPreview = (result: QueryResult | null) => {
    preview.clear();
    if (!result?.footprint) {
      return;
    }
    for (const zone of result.zones) {
      rectPath(preview, zone.rect)
        .fill({ color: COLOURS.zone, alpha: 0.16 })
        .stroke({ color: COLOURS.zone, alpha: 0.6, width: 1, pixelLine: true });
    }
    rectPath(preview, result.footprint)
      .fill({ color: result.allowed ? COLOURS.allowed : COLOURS.refused, alpha: 0.5 })
      .stroke({
        color: result.allowed ? COLOURS.allowed : COLOURS.refused,
        width: 1,
        pixelLine: true,
      });
    for (const problem of result.problems) {
      if (problem.rect) {
        rectPath(preview, problem.rect)
          .fill({ color: COLOURS.problem, alpha: 0.45 })
          .stroke({ color: COLOURS.problem, width: 1, pixelLine: true });
      }
    }
  };

  const countDisplayObjects = (node: Container): number =>
    1 + node.children.reduce((sum, child) => sum + countDisplayObjects(child), 0);

  return {
    render(frame, camera, viewport) {
      if (destroyed || viewport.width <= 0 || viewport.height <= 0) {
        return;
      }
      if (viewport.width !== lastViewport.width || viewport.height !== lastViewport.height) {
        app.renderer.resize(viewport.width, viewport.height);
      }
      const ppm = pixelsPerMetreOf(camera);
      const transform = cameraTransform(camera, viewport);
      world.scale.set(transform.scale);
      world.position.set(transform.x, transform.y);
      if (scene !== null && scene.levelIndex !== frame.scene.levelIndex) {
        scene = null;
      }
      drawStructure(frame, ppm);
      floor.update(frame, visibleWorldRect(camera, viewport), ppm);
      drawGrid(frame, ppm);
      drawZones(frame);
      applyObjects(frame.scene);
      drawPresentation(frame, camera, viewport);
      level = frame.level;
      lastCamera = camera;
      lastViewport = viewport;
      app.render();
      frames += 1;
    },
    stats(): SceneStats {
      const redrawsById: Record<string, number> = {};
      for (const [id, sprite] of sprites) {
        redrawsById[id] = sprite.redraws;
      }
      return {
        frames,
        displayObjects: countDisplayObjects(app.stage),
        floorCells: (floor.model?.cols ?? 0) * (floor.model?.rows ?? 0),
        floorChunks: (floor.model?.chunkCols ?? 0) * (floor.model?.chunkRows ?? 0),
        floorChunksVisible: floor.visibleCount,
        floorChunkRedraws: floor.redraws,
        floorDetail: floor.detail,
        objectSprites: sprites.size,
        objectRedraws,
        objectSpritesCreated: spritePool.created,
        objectSpritesPooled: spritePool.free,
        objectRedrawsById: redrawsById,
      };
    },
    boundsOf(id) {
      if (!lastCamera || !level) {
        return null;
      }
      // The drawn bounds of the display object itself, as PixiJS computes them on the canvas.
      const target = id === 'floor' ? slab : sprites.get(id)?.art;
      if (!target) {
        return null;
      }
      const bounds = target.getBounds();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    },
    readPixels(rect: ScreenRect) {
      const frame = new Rectangle(rect.x, rect.y, rect.width, rect.height);
      const extracted = app.renderer.extract.pixels({ target: app.stage, frame, resolution: 1 });
      return Promise.resolve({
        width: extracted.width,
        height: extracted.height,
        data: Array.from(extracted.pixels),
      });
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      for (const text of usedLabels.splice(0)) {
        labelPool.release(text);
      }
      labelPool.drain((text) => {
        text.destroy();
      });
      for (const sprite of sprites.values()) {
        spritePool.release(sprite);
      }
      sprites.clear();
      spritePool.drain((sprite) => {
        sprite.container.destroy({ children: true });
      });
      floor.destroy();
      app.destroy({ removeView: true }, { children: true });
    },
  };
}
