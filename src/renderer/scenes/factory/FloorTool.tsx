import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FacilitiesView,
  FloorQuoteResult,
  PremisesLevelView,
} from '../../../shared/ipc/facilities';
import type { Units } from '../../app/desktop/profile-store';
import { formatCents } from '../../app/money-input';
import { formatAreaPrecise } from '../../app/units';
import type { SimulationHostView } from '../../app/useSimulationHost';
import { buildFloorModel } from './floor-model';
import {
  fillRects,
  levelRects,
  rectBetween,
  runsToRects,
  SELECTION_SHAPE_LABEL,
  selectionRuns,
  worksCells,
  type CellRect,
  type FloorSelectionShape,
  type FloorTool,
} from './floor-selection';

/**
 * The layout-mode floor tool (plan Step 09A; spec §5.6; ADR-0046, ADR-0052):
 * select cells (a single cell, a rectangle between two clicks, the whole
 * level, or a fill), preview the material in place, see the worker's exact
 * quote, and order the work. The selection and preview are renderer state;
 * the order is one validated command carrying explicit rectangles, which
 * the worker checks and prices again.
 */

interface Cell {
  readonly col: number;
  readonly row: number;
}

export interface FloorSelection {
  /** The rectangles the order will carry. */
  readonly rects: readonly CellRect[];
  /** The first corner of a rectangle being drawn, or null. */
  readonly anchor: Cell | null;
  /** The worker's quote for exactly this selection, or null while it is asked. */
  readonly quote: FloorQuoteResult | null;
  /** The level as drawn: the selection previewed in the tool's material. */
  readonly previewLevel: PremisesLevelView;
  readonly marks: {
    readonly selection: readonly (readonly [number, number, number])[];
    readonly allowed: boolean | null;
    readonly works: readonly (readonly [number, number, number])[];
  };
  /** A click on a cell, with Shift adding to the selection. */
  readonly click: (cell: Cell, add: boolean) => void;
  readonly selectLevel: () => void;
  readonly clear: () => void;
}

/** The selection's eligible cells as rectangles; the raw rectangles if none is eligible, so the worker can say why. */
function orderRects(level: PremisesLevelView, rects: readonly CellRect[]): CellRect[] {
  const eligible = runsToRects(selectionRuns(level, rects));
  return eligible.length > 0 ? eligible : [...rects];
}

export function useFloorSelection(input: {
  readonly tool: FloorTool | null;
  readonly level: PremisesLevelView | null;
  readonly propertyId: string | null;
  readonly surfaceMaterialId: string;
  readonly materials: FacilitiesView['floorMaterials'];
  readonly hover: Cell | null;
  readonly host: Pick<SimulationHostView, 'query'> | undefined;
  /** Changes whenever the world changes, so a quote is asked again. */
  readonly revision: unknown;
}): FloorSelection | null {
  const { tool, level, propertyId, hover, host } = input;
  const [picked, setPicked] = useState<{ key: string; rects: CellRect[] }>({ key: '', rects: [] });
  const [anchor, setAnchor] = useState<{ key: string; cell: Cell } | null>(null);
  const [answer, setAnswer] = useState<{ key: string; result: FloorQuoteResult | null } | null>(
    null,
  );
  const latest = useRef('');
  // A selection belongs to one level of one building.
  const scope = level && propertyId ? `${propertyId}|${level.index}` : '';
  const rects = useMemo(() => (picked.key === scope ? picked.rects : []), [picked, scope]);
  const corner = anchor?.key === scope ? anchor.cell : null;
  // While a rectangle is being drawn, the rectangle so far is part of the selection.
  const shown = useMemo(
    () => (corner && hover ? [...rects, rectBetween(corner, hover)] : rects),
    [rects, corner, hover],
  );
  const ordered = useMemo(() => (level ? orderRects(level, shown) : []), [level, shown]);
  const material = tool?.materialId ?? '';
  const key =
    tool && level && propertyId && ordered.length > 0 && !corner
      ? `${scope}|${material}|${JSON.stringify(ordered)}`
      : '';

  useEffect(() => {
    latest.current = key;
    if (!key || !level || !propertyId || !host) {
      return;
    }
    void host
      .query({
        kind: 'floorQuote',
        propertyId,
        level: level.index,
        materialId: material,
        rectangles: ordered,
      })
      .then((result) => {
        if (latest.current === key) {
          setAnswer({ key, result: result?.kind === 'floorQuote' ? result : null });
        }
      });
    // `key` captures the selection and material, and `revision` the world they are priced against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, input.revision]);

  const runs = useMemo(() => (level ? selectionRuns(level, shown) : []), [level, shown]);
  const previewLevel = useMemo(() => {
    if (!level || !tool || runs.length === 0) {
      return level;
    }
    return {
      ...level,
      coverings: [
        ...level.coverings,
        ...runs.map(
          ([row, from, to]) =>
            [row, from, to, tool.materialId, 'preview'] as [number, number, number, string, string],
        ),
      ],
    };
  }, [level, tool, runs]);
  const works = useMemo(() => level?.works.flatMap((job) => job.runs) ?? [], [level]);

  if (!tool || !level || !propertyId || !previewLevel) {
    return null;
  }
  const quote = answer?.key === key ? answer.result : null;
  const set = (next: CellRect[], add: boolean) => {
    setPicked({ key: scope, rects: add ? [...rects, ...next] : next });
  };
  return {
    rects: ordered,
    anchor: corner,
    quote,
    previewLevel,
    marks: { selection: runs, allowed: quote ? quote.allowed : null, works },
    click: (cell, add) => {
      const shape: FloorSelectionShape = tool.shape;
      if (shape === 'cell') {
        set([{ col: cell.col, row: cell.row, cols: 1, rows: 1 }], add);
      } else if (shape === 'rectangle') {
        if (corner) {
          set([rectBetween(corner, cell)], add);
          setAnchor(null);
        } else {
          setAnchor({ key: scope, cell });
        }
      } else if (shape === 'level') {
        set(levelRects(level), false);
      } else {
        const model = buildFloorModel(
          level,
          input.surfaceMaterialId,
          input.materials.map((item) => item.id),
        );
        const filled = fillRects(model, worksCells(level), cell);
        set(filled.length > 0 ? filled : [{ col: cell.col, row: cell.row, cols: 1, rows: 1 }], add);
      }
    },
    selectLevel: () => {
      setAnchor(null);
      set(levelRects(level), false);
    },
    clear: () => {
      setAnchor(null);
      set([], false);
    },
  };
}

const SHAPES: readonly FloorSelectionShape[] = ['cell', 'rectangle', 'level', 'fill'];

/** The floor tool's status strip: material, selection shape, the quote and the order button. */
export function FloorToolStatus({
  tool,
  selection,
  materials,
  units,
  pending,
  onTool,
  onOrder,
}: {
  readonly tool: FloorTool;
  readonly selection: FloorSelection;
  readonly materials: FacilitiesView['floorMaterials'];
  readonly units: Units;
  readonly pending: boolean;
  readonly onTool: (tool: FloorTool | null) => void;
  readonly onOrder: () => void;
}) {
  const nameOf = (id: string) => materials.find((item) => item.id === id)?.name ?? id;
  const sold = materials.filter((item) => item.installCentsPerM2 !== null);
  const { quote } = selection;
  const figures = quote?.quote ?? null;
  const hint =
    tool.shape === 'rectangle'
      ? selection.anchor
        ? 'Click the opposite corner.'
        : 'Click one corner of the rectangle.'
      : tool.shape === 'level'
        ? 'Click the floor to select every usable cell of this level.'
        : tool.shape === 'fill'
          ? 'Click a cell to select the connected area with the same floor.'
          : 'Click a cell.';
  return (
    <span data-testid="floor-tool" data-material={tool.materialId} data-shape={tool.shape}>
      <strong>Floor covering</strong>{' '}
      <label>
        Material{' '}
        <select
          aria-label="Floor material"
          value={tool.materialId}
          onChange={(event) => {
            onTool({ ...tool, materialId: event.target.value });
          }}
        >
          {sold.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>{' '}
      <span role="group" aria-label="Select cells by" className="factory-viewport-modes">
        {SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            aria-pressed={tool.shape === shape}
            onClick={() => {
              onTool({ ...tool, shape });
              if (shape === 'level') {
                selection.selectLevel();
              }
            }}
          >
            {SELECTION_SHAPE_LABEL[shape]}
          </button>
        ))}
      </span>{' '}
      {hint} Shift adds to the selection; Esc clears it.{' '}
      <button type="button" onClick={selection.clear} disabled={selection.rects.length === 0}>
        Clear
      </button>{' '}
      <button
        type="button"
        onClick={() => {
          onTool(null);
        }}
      >
        Close
      </button>
      <br />
      <span
        data-testid="floor-quote"
        data-allowed={quote ? String(quote.allowed) : ''}
        data-total={figures?.totalCents ?? ''}
        data-install={figures?.installCents ?? ''}
        data-removal={figures?.removalCents ?? ''}
        data-cells={figures?.cells ?? ''}
        data-area={figures?.areaMm2 ?? ''}
      >
        {selection.rects.length === 0 ? (
          'Nothing selected.'
        ) : quote === null ? (
          'Pricing…'
        ) : figures ? (
          <>
            {figures.cells.toLocaleString('en-US')} {figures.cells === 1 ? 'cell' : 'cells'},{' '}
            {formatAreaPrecise(figures.areaMm2, units)} of {nameOf(tool.materialId)}
            {figures.skippedCells > 0
              ? ` (${figures.skippedCells.toLocaleString('en-US')} already laid, not charged)`
              : ''}
            : laying {formatCents(figures.installCents)}
            {figures.replacedCells > 0
              ? `; taking up ${figures.removals
                  .map(
                    (removal) =>
                      `${formatAreaPrecise(removal.areaMm2, units)} of ${nameOf(removal.materialId)}`,
                  )
                  .join(', ')} ${formatCents(figures.removalCents)}`
              : ''}
            ; total <strong>{formatCents(figures.totalCents)}</strong>. The contractor finishes on{' '}
            {figures.completesOn} ({figures.workDays} {figures.workDays === 1 ? 'day' : 'days'}
            ); the cells are out of use until then.{' '}
            {quote.refusal ? <span role="alert">{quote.refusal}.</span> : null}{' '}
            <button
              type="button"
              data-testid="floor-order"
              disabled={!quote.allowed || pending}
              onClick={onOrder}
            >
              Order floor works
            </button>
          </>
        ) : (
          <span role="alert">Not allowed: {quote.refusal}</span>
        )}
      </span>
    </span>
  );
}
