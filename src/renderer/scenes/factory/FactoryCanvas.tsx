import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { useElementSize } from '../../app/desktop/useElementSize';
import {
  panBy,
  pixelsPerMetreOf,
  screenToWorld,
  zoomAbout,
  type Camera,
  type ViewportSize,
  type WorldPoint,
} from './camera';
import type { SceneFrame } from './scene-model';
import { SceneFactoryContext, type FactoryScene } from './scene-port';
import { attachScene, detachScene } from './scene-probe';

/**
 * The factory canvas (ADR-0051): the PixiJS scene in a DOM host that owns
 * all input. A pointer position becomes world millimetres through the
 * camera's exact inverse, and the parent decides what it means (hover,
 * select, place). Dragging pans, the wheel and + / − zoom a ladder step
 * about the pointer, the arrow keys pan. The camera only pans and zooms.
 * Nothing here changes the world: commands are the parent's, through IPC.
 */

const DRAG_THRESHOLD_PX = 4;
const NO_SIZE: ViewportSize = { width: 0, height: 0 };

export interface FactoryCanvasProps {
  readonly frame: SceneFrame;
  readonly camera: Camera;
  readonly onCameraChange: (camera: Camera) => void;
  readonly onPointer: (at: WorldPoint | null) => void;
  readonly onFloorClick: (at: WorldPoint) => void;
  readonly label: string;
}

export function FactoryCanvas({
  frame,
  camera,
  onCameraChange,
  onPointer,
  onFloorClick,
  label,
}: FactoryCanvasProps) {
  const factory = useContext(SceneFactoryContext);
  const [measure, measured] = useElementSize<HTMLDivElement>();
  const viewport = measured ?? NO_SIZE;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneHostRef = useRef<HTMLDivElement | null>(null);
  const [scene, setScene] = useState<FactoryScene | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; camera: Camera; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const setHost = useCallback(
    (element: HTMLDivElement | null) => {
      hostRef.current = element;
      measure(element);
    },
    [measure],
  );

  useEffect(() => {
    const host = sceneHostRef.current;
    if (!host) {
      return undefined;
    }
    let cancelled = false;
    let made: FactoryScene | null = null;
    factory(host).then(
      (created) => {
        if (cancelled) {
          created.destroy();
          return;
        }
        made = created;
        attachScene(created, host);
        setScene(created);
      },
      (error: unknown) => {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      cancelled = true;
      if (made) {
        detachScene(made);
        made.destroy();
      }
      setScene(null);
    };
  }, [factory]);

  useEffect(() => {
    scene?.render(frame, camera, viewport);
  }, [scene, frame, camera, viewport]);

  /** A client position in the canvas's own CSS pixels (the UI scale may zoom the desktop). */
  const local = (clientX: number, clientY: number) => {
    const element = hostRef.current;
    const box = element?.getBoundingClientRect();
    if (!element || !box) {
      return { x: 0, y: 0 };
    }
    const ratio = box.width > 0 && element.clientWidth > 0 ? element.clientWidth / box.width : 1;
    return { x: (clientX - box.left) * ratio, y: (clientY - box.top) * ratio };
  };
  const worldAt = (clientX: number, clientY: number) => {
    const point = local(clientX, clientY);
    return screenToWorld(camera, viewport, point.x, point.y);
  };

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) {
      return;
    }
    const start = local(event.clientX, event.clientY);
    drag.current = { x: start.x, y: start.y, camera, moved: false };
    const move = (moveEvent: MouseEvent) => {
      const state = drag.current;
      if (!state) {
        return;
      }
      const at = local(moveEvent.clientX, moveEvent.clientY);
      const dx = at.x - state.x;
      const dy = at.y - state.y;
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      state.moved = true;
      onCameraChange(panBy(state.camera, dx, dy));
    };
    const up = () => {
      suppressClick.current = drag.current?.moved === true;
      drag.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { x: viewport.width / 4, y: viewport.height / 4 };
    const pans: Record<string, [number, number]> = {
      ArrowLeft: [step.x, 0],
      ArrowRight: [-step.x, 0],
      ArrowUp: [0, step.y],
      ArrowDown: [0, -step.y],
    };
    const pan = pans[event.key];
    if (pan) {
      event.preventDefault();
      onCameraChange(panBy(camera, pan[0], pan[1]));
    } else if (event.key === '+' || event.key === '=') {
      onCameraChange(zoomAbout(camera, viewport, camera.zoomIndex + 1));
    } else if (event.key === '-') {
      onCameraChange(zoomAbout(camera, viewport, camera.zoomIndex - 1));
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) {
      return;
    }
    const anchor = local(event.clientX, event.clientY);
    onCameraChange(
      zoomAbout(camera, viewport, camera.zoomIndex + (event.deltaY < 0 ? 1 : -1), anchor),
    );
  };

  return (
    // The plan is an application widget with its own pointer and keyboard model (pan, zoom,
    // select); its records are reachable as text in the status strip and the windows.
    // eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions
    <div
      ref={setHost}
      className="factory-canvas-host"
      role="application"
      aria-label={label}
      aria-roledescription="factory floor plan"
      // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex -- keyboard pan and zoom
      tabIndex={0}
      data-testid="facility-floor-plan"
      data-mode={frame.mode}
      data-level={frame.level.index}
      data-pixels-per-metre={pixelsPerMetreOf(camera)}
      data-camera-x-mm={camera.centreXMm}
      data-camera-y-mm={camera.centreYMm}
      data-scene-ready={scene !== null}
      onMouseDown={onMouseDown}
      onMouseMove={(event) => {
        if (!drag.current?.moved) {
          onPointer(worldAt(event.clientX, event.clientY));
        }
      }}
      onMouseLeave={() => {
        onPointer(null);
      }}
      onClick={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        onFloorClick(worldAt(event.clientX, event.clientY));
      }}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <div ref={sceneHostRef} className="factory-canvas-scene" />
      {failure ? (
        <p className="factory-viewport-refusal" role="alert">
          The factory drawing could not start: {failure}
        </p>
      ) : null}
    </div>
  );
}
