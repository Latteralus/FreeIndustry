import { useEffect, useMemo, useRef, useState } from 'react';
import type { FacilitiesView, QueryResult } from '../../shared/ipc/facilities';
import type { PropertyView } from '../../shared/ipc/real-estate';
import type { Units } from '../app/desktop/profile-store';
import { formatCents } from '../app/money-input';
import { formatArea, formatLength, PROPERTY_KIND_LABEL, scaleBarLength } from '../app/units';
import type { SimulationHostView } from '../app/useSimulationHost';
import {
  cameraOn,
  clampToBounds,
  clampZoom,
  pixelsPerMetreOf,
  type Camera,
  type FactoryMode,
  type WorldPoint,
} from './factory/camera';
import { FactoryCanvas } from './factory/FactoryCanvas';
import { buildSceneModel, hitTest, type SceneFrame } from './factory/scene-model';
import { useFixtureLevel } from './factory/scene-probe';
import { FloorPlan } from './FloorPlan';
import { DEFAULT_ZOOM_INDEX, GRID_MM, LATTICE_MM, snap, ZOOM_STEPS } from './plan-transform';

/**
 * The factory viewport: the workspace background that management windows
 * open over (spec §3.2). It is mounted once and stays behind every window.
 *
 * With premises leased it shows the facility through the PixiJS factory
 * scene (plan Step 09; D11, ADR-0044, ADR-0051): one orthographic,
 * north-up, straight-down projection in every mode, from the same physical
 * coordinates. The three modes share one camera and differ only in tools
 * and overlays:
 *
 * - **Operating**: the live plant, each item with its operational state.
 * - **Layout**: the construction grid, the placement sub-grid, the cell
 *   inspector and the placement tools. The preview follows the pointer on
 *   the placement lattice, the worker checks it (a read-only query) and
 *   shows why it is or is not allowed, and a click submits the real command,
 *   which the worker validates again.
 * - **Inspection**: keep-clear landings, every item's zones, and each item's
 *   measured footprint.
 *
 * Clicking an item selects the same entity in every mode. Switching mode,
 * panning or zooming never sends a command.
 */

/** The placement tool: installing an owned item, or moving an installed one. */
export interface LayoutTool {
  readonly kind: 'install' | 'move';
  readonly equipmentId: string;
  readonly typeId: string;
  readonly rotation: number;
}

export interface FactoryViewportProps {
  readonly companyName: string | null;
  /** The property the company leases, or null. */
  readonly premises: PropertyView | null;
  readonly units: Units;
  /** The facilities read model; null in worlds made before Step 08. */
  readonly facilities?: FacilitiesView | null;
  readonly mode?: FactoryMode;
  readonly onMode?: (mode: FactoryMode) => void;
  readonly tool?: LayoutTool | null;
  readonly onTool?: (tool: LayoutTool | null) => void;
  /** The selected entity, shared with the management windows; local when omitted. */
  readonly selectedId?: string | null;
  readonly onSelect?: (id: string | null) => void;
  /** Bumped by a window's "Show on floor" to centre the view on the selection. */
  readonly focusRequest?: number;
  readonly host?: Pick<SimulationHostView, 'submit' | 'query' | 'pending'>;
}

const turn = (rotation: number) => (rotation + 90) % 360;

const MODE_LABEL: Record<FactoryMode, string> = {
  operating: 'Operating',
  layout: 'Layout',
  inspection: 'Inspection',
};

export function FactoryViewport({
  companyName,
  premises,
  units,
  facilities = null,
  mode = 'operating',
  onMode,
  tool = null,
  onTool,
  selectedId: sharedSelection,
  onSelect,
  focusRequest = 0,
  host,
}: FactoryViewportProps) {
  const [levelIndex, setLevelIndex] = useState(0);
  const [showGrid, setShowGrid] = useState(true);
  const [subGrid, setSubGrid] = useState(false);
  const [hover, setHover] = useState<WorldPoint | null>(null);
  const [answer, setAnswer] = useState<{ key: string; result: QueryResult | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const selectedId = sharedSelection === undefined ? localSelection : sharedSelection;
  const select = (id: string | null) => {
    setLocalSelection(id);
    onSelect?.(id);
  };
  const latest = useRef('');
  const layoutMode = mode === 'layout';

  const site = facilities?.premises?.propertyId === premises?.id ? facilities?.premises : null;
  const ownLevel =
    site?.levels.find((candidate) => candidate.index === levelIndex) ?? site?.levels[0];
  const fixtureLevel = useFixtureLevel();
  const level = fixtureLevel ?? ownLevel;
  const installed = (facilities?.equipment ?? []).filter(
    (item) => item.placement?.propertyId === site?.propertyId,
  );
  const toolType = tool ? facilities?.equipmentTypes.find((type) => type.id === tool.typeId) : null;

  // One camera for every mode, re-centred only when the floor being shown changes.
  const viewKey =
    site && level ? `${site.propertyId}|${level.index}|${fixtureLevel ? 'fixture' : ''}` : '';
  const [camera, setCamera] = useState<{ key: string; camera: Camera } | null>(null);
  const zoomIndex = camera?.camera.zoomIndex ?? DEFAULT_ZOOM_INDEX;
  const activeCamera =
    level && camera?.key === viewKey
      ? camera.camera
      : level
        ? cameraOn(level.bounds, zoomIndex)
        : null;
  const pixelsPerMetre = activeCamera
    ? pixelsPerMetreOf(activeCamera)
    : (ZOOM_STEPS[zoomIndex] ?? 10);
  const changeCamera = (next: Camera) => {
    setCamera({ key: viewKey, camera: level ? clampToBounds(next, level.bounds) : next });
  };
  // The zoom buttons zoom about the viewport centre: the centre point stays where it is.
  const setZoom = (index: number) => {
    if (activeCamera) {
      changeCamera({ ...activeCamera, zoomIndex: clampZoom(index) });
    } else {
      // No facility geometry (a world from before Step 08): the plain floor plan still zooms.
      setCamera({
        key: viewKey,
        camera: { centreXMm: 0, centreYMm: 0, zoomIndex: clampZoom(index) },
      });
    }
  };

  const scene = useMemo(
    () =>
      premises && site && level
        ? buildSceneModel(
            premises,
            level,
            facilities ?? { equipment: [], equipmentTypes: [] },
            site.propertyId,
          )
        : null,
    [premises, site, level, facilities],
  );
  const selected = scene?.objects.find(
    (object): object is Extract<typeof object, { kind: 'equipment' }> =>
      object.kind === 'equipment' && object.id === selectedId,
  );
  const hovered = hover && scene && !tool ? hitTest(scene, hover.xMm, hover.yMm) : null;

  // "Show on floor" from a window: centre on the selected item, keeping the zoom
  // (adjusting state while rendering, once per request).
  const [handledFocus, setHandledFocus] = useState(focusRequest);
  if (focusRequest !== handledFocus) {
    setHandledFocus(focusRequest);
    if (selected) {
      setCamera({ key: viewKey, camera: cameraOn(selected.rect, zoomIndex) });
    }
  }

  // Where the preview stands: the pointer at its centre, snapped to the grid or the sub-grid.
  const target = useMemo(() => {
    if (!layoutMode || !tool || !toolType || !hover || !level) {
      return null;
    }
    const quarter = tool.rotation === 90 || tool.rotation === 270;
    const width = quarter ? toolType.depthMm : toolType.widthMm;
    const depth = quarter ? toolType.widthMm : toolType.depthMm;
    const step = subGrid ? LATTICE_MM : GRID_MM;
    return {
      xMm: Math.max(0, snap(hover.xMm - width / 2, step)),
      yMm: Math.max(0, snap(hover.yMm - depth / 2, step)),
      level: level.index,
    };
  }, [layoutMode, tool, toolType, hover, level, subGrid]);

  const key =
    target && tool
      ? `${tool.equipmentId}|${target.level}|${target.xMm}|${target.yMm}|${tool.rotation}`
      : '';
  useEffect(() => {
    latest.current = key;
    if (!target || !tool || !site || !host) {
      return;
    }
    void host
      .query({
        kind: 'placement',
        equipmentTypeId: tool.typeId,
        equipmentId: tool.equipmentId,
        propertyId: site.propertyId,
        level: target.level,
        xMm: target.xMm,
        yMm: target.yMm,
        rotation: tool.rotation,
      })
      .then((result) => {
        if (latest.current === key) {
          setAnswer({ key, result });
        }
      });
    // `key` captures everything the query depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!tool || !onTool) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
      if (typing) {
        return;
      }
      if (event.key === 'Escape') {
        onTool(null);
        setMessage(null);
      } else if (event.key === 'r' || event.key === 'R') {
        onTool({ ...tool, rotation: turn(tool.rotation) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [tool, onTool]);

  // The worker's verdict on exactly the placement shown, never a stale one.
  const preview = answer?.key === key ? answer.result : null;

  const place = async () => {
    if (!tool || !target || !site || !host) {
      return;
    }
    const outcome = await host.submit(
      tool.kind === 'install' ? 'equipment.install' : 'equipment.move',
      {
        equipmentId: tool.equipmentId,
        propertyId: site.propertyId,
        level: target.level,
        xMm: target.xMm,
        yMm: target.yMm,
        rotation: tool.rotation,
      },
    );
    if (outcome?.kind === 'accepted') {
      setMessage(null);
      select(tool.equipmentId);
      onTool?.(null);
    } else if (outcome?.kind === 'rejected') {
      setMessage(outcome.error.message);
    }
  };

  const cellInfo = (() => {
    if (!layoutMode || tool || !hover || !level) {
      return null;
    }
    const col = Math.floor(hover.xMm / GRID_MM);
    const row = Math.floor(hover.yMm / GRID_MM);
    if (col < 0 || row < 0 || col >= level.cells.cols || row >= level.cells.rows) {
      return null;
    }
    const partial = level.partialCells.find(([c, r]) => c === col && r === row);
    const eligible = level.eligibleRuns.some(
      ([r, from, to]) => r === row && col >= from && col < to,
    );
    const covering = level.coverings.find((cell) => cell.col === col && cell.row === row);
    const materialId = covering?.materialId ?? site?.surfaceMaterialId ?? '';
    const material =
      facilities?.floorMaterials.find((item) => item.id === materialId)?.name ?? materialId;
    if (!eligible) {
      return `Cell (${col}, ${row}): outside the usable floor`;
    }
    const area = partial ? String(partial[2]) : '250000';
    return `Cell (${col}, ${row}): ${partial ? 'partial' : 'full'}, ${formatArea(area, units)} · ${material}`;
  })();

  if (!premises) {
    return (
      <div
        className="factory-viewport"
        role="region"
        aria-label="Factory floor"
        data-testid="factory-viewport"
      >
        <div className="factory-viewport-empty">
          <p className="factory-viewport-title">No facility</p>
          <p>
            {companyName === null
              ? 'No company has been founded.'
              : `${companyName} has no premises yet.`}{' '}
            Choose a property from City → City View and lease it; its floor is then drawn here to
            its real dimensions.
          </p>
        </div>
      </div>
    );
  }

  const zoom = activeCamera?.zoomIndex ?? zoomIndex;
  const zoomButtons = (
    <span className="factory-viewport-zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        aria-label="Zoom out"
        disabled={zoom === 0}
        onClick={() => {
          setZoom(zoom - 1);
        }}
      >
        −
      </button>
      <span data-testid="viewport-scale">{pixelsPerMetre} px/m</span>
      <button
        type="button"
        aria-label="Zoom in"
        disabled={zoom === ZOOM_STEPS.length - 1}
        onClick={() => {
          setZoom(zoom + 1);
        }}
      >
        +
      </button>
      {level ? (
        <button
          type="button"
          onClick={() => {
            setCamera({ key: viewKey, camera: cameraOn(level.bounds, zoom) });
          }}
        >
          Centre
        </button>
      ) : null}
    </span>
  );
  const contents =
    installed.length === 0
      ? 'Empty: no equipment, staff or stock'
      : `${installed.length} ${installed.length === 1 ? 'item' : 'items'} of equipment installed (idle until production, Step 13); no staff or stock`;

  const frame: SceneFrame | null =
    scene && level && site && facilities
      ? {
          mode,
          scene,
          level,
          surfaceMaterialId: site.surfaceMaterialId,
          materials: facilities.floorMaterials,
          showGrid: layoutMode && showGrid,
          showSubGrid: layoutMode && subGrid,
          selectedId,
          hoverId: hovered?.id ?? null,
          preview: layoutMode && tool ? preview : null,
        }
      : null;
  const bar = scaleBarLength(pixelsPerMetre, units);

  const selectedRecord = selected ? (
    <>
      <strong>{selected.name}</strong> ({selected.id}) at {formatLength(selected.rect.x, units)},{' '}
      {formatLength(selected.rect.y, units)}, {formatLength(selected.rect.width, units)} ×{' '}
      {formatLength(selected.rect.depth, units)}, turned {selected.rotation}° · state: idle (no
      production until Step 13).
    </>
  ) : null;

  return (
    <div
      className="factory-viewport"
      role="region"
      aria-label="Factory floor"
      data-testid="factory-viewport"
    >
      <div className="factory-viewport-floor">
        <div className="factory-viewport-caption" data-testid="facility-caption">
          <strong>{premises.address}</strong> · {PROPERTY_KIND_LABEL[premises.kind]},{' '}
          {formatArea(premises.areaMm2, units)} · {contents}
          {zoomButtons}
        </div>
        {site && level ? (
          <div className="factory-viewport-tools" role="toolbar" aria-label="Factory view">
            <span role="group" aria-label="Display mode" className="factory-viewport-modes">
              {(['operating', 'layout', 'inspection'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={mode === candidate}
                  onClick={() => {
                    if (candidate !== 'layout') {
                      onTool?.(null);
                    }
                    onMode?.(candidate);
                  }}
                >
                  {MODE_LABEL[candidate]}
                </button>
              ))}
            </span>
            {site.levels.length > 1 ? (
              <label>
                Level{' '}
                <select
                  value={level.index}
                  onChange={(event) => {
                    setLevelIndex(Number(event.target.value));
                  }}
                >
                  {site.levels.map((candidate) => (
                    <option key={candidate.index} value={candidate.index}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {layoutMode ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={showGrid}
                    onChange={(event) => {
                      setShowGrid(event.target.checked);
                    }}
                  />{' '}
                  Grid (500 mm)
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={subGrid}
                    onChange={(event) => {
                      setSubGrid(event.target.checked);
                    }}
                  />{' '}
                  250 mm sub-grid and snap
                </label>
              </>
            ) : null}
            <span data-testid="level-area">
              {level.name}: usable {formatArea(level.usableAreaMm2, units)} of{' '}
              {formatArea(level.outlineAreaMm2, units)}; {level.cells.cols * level.cells.rows} cells
              ({level.cells.full} full, {level.cells.partial} partial, {level.cells.outside}{' '}
              outside) · power{' '}
              {(site.installedPowerVa / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}{' '}
              of {site.powerKva} kVA in use
            </span>
            {fixtureLevel ? (
              <strong data-testid="fixture-notice">Test fixture drawing (not the world)</strong>
            ) : null}
          </div>
        ) : null}
        {site && level ? (
          <div className="factory-viewport-status" data-testid="layout-status" aria-live="polite">
            {layoutMode && tool && toolType ? (
              <>
                <strong>
                  {tool.kind === 'install' ? 'Installing' : 'Moving'} {toolType.name}
                </strong>{' '}
                ({formatLength(toolType.widthMm, units)} × {formatLength(toolType.depthMm, units)},
                turned {tool.rotation}°). R turns it, Esc cancels, click places it.{' '}
                <button
                  type="button"
                  onClick={() => {
                    onTool?.({ ...tool, rotation: turn(tool.rotation) });
                  }}
                >
                  Turn
                </button>{' '}
                <button
                  type="button"
                  onClick={() => {
                    onTool?.(null);
                    setMessage(null);
                  }}
                >
                  Cancel
                </button>{' '}
                <span data-testid="placement-verdict">
                  {preview === null
                    ? 'Point at the floor.'
                    : preview.allowed
                      ? `Allowed${preview.chargeCents !== '0' ? `; the dealer charges ${formatCents(preview.chargeCents)}` : ''}.`
                      : `Not allowed: ${preview.refusal ?? preview.problems[0]?.message ?? ''}${preview.problems.length > 1 ? ` (and ${preview.problems.length - 1} more)` : ''}`}
                </span>
                {preview?.footprint ? (
                  <span
                    hidden
                    data-testid="placement-ghost"
                    data-allowed={preview.allowed}
                    data-footprint={`${preview.footprint.x},${preview.footprint.y},${preview.footprint.width},${preview.footprint.depth}`}
                    data-problems={preview.problems.filter((problem) => problem.rect).length}
                  />
                ) : null}
              </>
            ) : selectedRecord ? (
              <span data-testid="selection-record" data-entity-id={selected?.id}>
                {selectedRecord}{' '}
                {layoutMode && selected ? (
                  <>
                    <button
                      type="button"
                      disabled={host?.pending}
                      onClick={() => {
                        const item = installed.find((candidate) => candidate.id === selected.id);
                        onTool?.({
                          kind: 'move',
                          equipmentId: selected.id,
                          typeId: selected.typeId,
                          rotation: item?.placement?.rotation ?? selected.rotation,
                        });
                      }}
                    >
                      Move…
                    </button>{' '}
                    <button
                      type="button"
                      disabled={host?.pending}
                      onClick={() => {
                        void host
                          ?.submit('equipment.uninstall', { equipmentId: selected.id })
                          .then((outcome) => {
                            setMessage(outcome?.kind === 'rejected' ? outcome.error.message : null);
                            select(null);
                          });
                      }}
                    >
                      Remove from floor
                    </button>
                  </>
                ) : null}
              </span>
            ) : layoutMode ? (
              <span data-testid="cell-info">
                {cellInfo ??
                  'Choose an item in Catalog → Equipment Catalog to install it, or click an installed item.'}
              </span>
            ) : mode === 'inspection' ? (
              <span>
                Inspection: keep-clear landings (green), operator, maintenance and clearance zones
                (blue) and material ports (amber) are drawn; click an item for its record.
              </span>
            ) : (
              <span data-testid="operating-summary">
                {installed.length === 0
                  ? 'No equipment installed.'
                  : `${installed.length} idle (production begins in Step 13).`}{' '}
                Drag to pan, wheel to zoom, click an item to select it.
              </span>
            )}
            {message ? (
              <p className="factory-viewport-refusal" role="alert" data-testid="layout-refusal">
                {message}
              </p>
            ) : null}
          </div>
        ) : null}
        {frame && activeCamera ? (
          <div className="factory-viewport-stage">
            <FactoryCanvas
              frame={frame}
              camera={activeCamera}
              onCameraChange={changeCamera}
              onPointer={setHover}
              onFloorClick={(at) => {
                setHover(at);
                if (layoutMode && tool) {
                  void place();
                } else {
                  select(scene ? (hitTest(scene, at.xMm, at.yMm)?.id ?? null) : null);
                }
              }}
              label={`Floor plan of ${premises.address}, ${level?.name ?? ''}, drawn to scale, ${MODE_LABEL[mode]} mode`}
            />
            {hovered?.kind === 'equipment' ? (
              <div className="factory-viewport-tooltip" data-testid="hover-tooltip">
                {hovered.name} ({hovered.id})
              </div>
            ) : null}
            <div className="factory-viewport-scalebar" aria-hidden="true">
              <span style={{ width: bar.pixels }} />
              {bar.label}
            </div>
          </div>
        ) : (
          <FloorPlan
            property={premises}
            pixelsPerMetre={pixelsPerMetre}
            units={units}
            testId="facility-floor-plan"
          />
        )}
      </div>
    </div>
  );
}
