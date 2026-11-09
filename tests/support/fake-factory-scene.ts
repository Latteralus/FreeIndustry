import type { Camera, ViewportSize } from '../../src/renderer/scenes/factory/camera';
import type { SceneFrame } from '../../src/renderer/scenes/factory/scene-model';
import type { FactoryScene, SceneStats } from '../../src/renderer/scenes/factory/scene-port';

/**
 * jsdom has no GPU, so renderer tests replace the PixiJS scene module with
 * this recording fake (jest `moduleNameMapper`, renderer project). It keeps
 * every frame it is asked to draw, so a test can check what the factory
 * viewport handed the scene: the mode, the camera, the objects, the grid,
 * the selection and the placement preview. The real scene is measured in
 * the real app (`tests/e2e/factory-renderer.spec.ts`).
 */

export interface RecordedFrame {
  readonly frame: SceneFrame;
  readonly camera: Camera;
  readonly viewport: ViewportSize;
}

export interface FakeScene extends FactoryScene {
  readonly host: HTMLElement;
  readonly frames: RecordedFrame[];
  destroyed: boolean;
}

export const fakeScenes: FakeScene[] = [];

/** The last frame drawn by the newest live scene. */
export function lastFrame(): RecordedFrame {
  const scene = fakeScenes.filter((candidate) => !candidate.destroyed).at(-1);
  const frame = scene?.frames.at(-1);
  if (!frame) {
    throw new Error('the factory scene has drawn nothing');
  }
  return frame;
}

const EMPTY_STATS: SceneStats = {
  frames: 0,
  displayObjects: 0,
  floorCells: 0,
  floorChunks: 0,
  floorChunksVisible: 0,
  floorChunkRedraws: 0,
  floorDetail: 'flat',
  objectSprites: 0,
  objectRedraws: 0,
  objectSpritesCreated: 0,
  objectSpritesPooled: 0,
  objectRedrawsById: {},
};

export function createPixiFactoryScene(host: HTMLElement): Promise<FactoryScene> {
  const frames: RecordedFrame[] = [];
  const scene: FakeScene = {
    host,
    frames,
    destroyed: false,
    render(frame, camera, viewport) {
      frames.push({ frame, camera, viewport });
    },
    stats: () => ({ ...EMPTY_STATS, frames: frames.length }),
    boundsOf: () => null,
    readPixels: () => Promise.resolve({ width: 0, height: 0, data: [] }),
    destroy() {
      scene.destroyed = true;
    },
  };
  fakeScenes.push(scene);
  return Promise.resolve(scene);
}
