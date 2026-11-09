import { createContext } from 'react';
import type { Camera, ViewportSize } from './camera';
import type { FloorDetail } from './floor-model';
import type { SceneFrame } from './scene-model';

/**
 * The boundary between the React desktop and the factory scene (ADR-0051).
 * React owns presentation state (mode, camera, selection, previews) and
 * hands the scene a complete frame; the scene draws it and reports what it
 * drew. The PixiJS implementation is loaded on demand; jsdom tests, which
 * have no GPU, substitute a recording fake. Nothing here can reach the
 * worker or change the world.
 */

/** A rectangle on the canvas, in CSS pixels from its top-left corner. */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the scene holds, for tests and the performance record (no frame-rate claims; Step 33). */
export interface SceneStats {
  /** Frames drawn since the scene started. */
  readonly frames: number;
  /** Display objects in the scene graph now, all layers. */
  readonly displayObjects: number;
  /** Floor: cells in the level, chunks in the level, chunks drawn now, and chunk textures (re)drawn since start. */
  readonly floorCells: number;
  readonly floorChunks: number;
  readonly floorChunksVisible: number;
  readonly floorChunkRedraws: number;
  readonly floorDetail: FloorDetail;
  /** Objects: equipment sprites on stage, sprites (re)drawn since start, sprites ever created, and pooled spares. */
  readonly objectSprites: number;
  readonly objectRedraws: number;
  readonly objectSpritesCreated: number;
  readonly objectSpritesPooled: number;
  /** Per-object redraw counts, by entity id (an untouched sprite keeps its count). */
  readonly objectRedrawsById: Readonly<Record<string, number>>;
}

export interface FactoryScene {
  /** Draw a frame. Cheap when nothing changed. */
  render(frame: SceneFrame, camera: Camera, viewport: ViewportSize): void;
  stats(): SceneStats;
  /** Where an entity is drawn now: `floor` (the outline) or an object's id. */
  boundsOf(id: string): ScreenRect | null;
  /** Read back drawn pixels, RGBA rows, from a canvas rectangle in CSS pixels. */
  readPixels(rect: ScreenRect): Promise<{ width: number; height: number; data: number[] }>;
  destroy(): void;
}

export type SceneFactory = (host: HTMLElement) => Promise<FactoryScene>;

/** The real renderer: PixiJS, loaded when a factory is first shown. */
const loadPixiScene: SceneFactory = async (host) => {
  const { createPixiFactoryScene } = await import('./pixi/pixi-factory-scene');
  return createPixiFactoryScene(host);
};

export const SceneFactoryContext = createContext<SceneFactory>(loadPixiScene);
