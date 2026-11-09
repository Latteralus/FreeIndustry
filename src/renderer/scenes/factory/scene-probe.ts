import { useSyncExternalStore } from 'react';
import type { PremisesLevelView } from '../../../shared/ipc/facilities';
import type { FactoryScene, ScreenRect, SceneStats } from './scene-port';

/**
 * The factory scene's measurement probe for real-app tests (plan Step 09
 * gate; ADR-0051). It exists only when main started the window with
 * `FREEINDUSTRY_SCENE_PROBE=1`, which packaged builds ignore. It reads what
 * the scene drew (display-object bounds, pixels, counts) in page
 * coordinates, and it can substitute a fixture *level drawing* so floor
 * rendering can be measured on floors no command can make yet (Step 09A buys
 * coverings). A fixture changes only what is drawn, is labelled on screen,
 * and never reaches the worker or the world.
 */

interface SceneProbe {
  ready(): boolean;
  stats(): SceneStats | null;
  /** Bounds of `floor` or an entity id, in page (client) pixels. */
  boundsOf(id: string): ScreenRect | null;
  /** RGBA rows of a page rectangle, read back from the scene. */
  readPixels(rect: ScreenRect): Promise<{ width: number; height: number; data: number[] }>;
  /** Draw this level instead of the premises' own (null restores it). */
  setFixtureLevel(level: PremisesLevelView | null): void;
}

declare global {
  interface Window {
    __freeIndustryScene?: SceneProbe;
  }
}

let attached: { readonly scene: FactoryScene; readonly host: HTMLElement } | null = null;
let fixture: PremisesLevelView | null = null;
const listeners = new Set<() => void>();

export function attachScene(scene: FactoryScene, host: HTMLElement): void {
  attached = { scene, host };
}

export function detachScene(scene: FactoryScene): void {
  if (attached?.scene === scene) {
    attached = null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The fixture level a test asked the scene to draw, or null. */
export function useFixtureLevel(): PremisesLevelView | null {
  return useSyncExternalStore(subscribe, () => fixture);
}

/** Canvas CSS pixels → page pixels (the desktop's UI scale may zoom the canvas). */
function pageFrame(host: HTMLElement) {
  const box = host.getBoundingClientRect();
  const ratio = host.clientWidth > 0 ? box.width / host.clientWidth : 1;
  return { left: box.left, top: box.top, ratio };
}

export function installSceneProbe(target: Window): void {
  target.__freeIndustryScene = Object.freeze({
    ready: () => attached !== null,
    stats: () => attached?.scene.stats() ?? null,
    boundsOf: (id: string) => {
      if (!attached) {
        return null;
      }
      const rect = attached.scene.boundsOf(id);
      if (!rect) {
        return null;
      }
      const page = pageFrame(attached.host);
      return {
        x: page.left + rect.x * page.ratio,
        y: page.top + rect.y * page.ratio,
        width: rect.width * page.ratio,
        height: rect.height * page.ratio,
      };
    },
    readPixels: (rect: ScreenRect) => {
      if (!attached) {
        return Promise.resolve({ width: 0, height: 0, data: [] });
      }
      const page = pageFrame(attached.host);
      return attached.scene.readPixels({
        x: (rect.x - page.left) / page.ratio,
        y: (rect.y - page.top) / page.ratio,
        width: rect.width / page.ratio,
        height: rect.height / page.ratio,
      });
    },
    setFixtureLevel: (level: PremisesLevelView | null) => {
      fixture = level;
      for (const listener of listeners) {
        listener();
      }
    },
  });
}
