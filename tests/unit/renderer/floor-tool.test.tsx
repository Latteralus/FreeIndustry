import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type {
  FacilitiesView,
  QueryResult,
  SimulationQuery,
} from '../../../src/shared/ipc/facilities';
import type { RequestOutcome } from '../../../src/renderer/app/useSimulationHost';
import { buildFloorModel } from '../../../src/renderer/scenes/factory/floor-model';
import {
  fillRects,
  levelRects,
  rectBetween,
  runsToRects,
  selectionRuns,
  type FloorTool,
} from '../../../src/renderer/scenes/factory/floor-selection';
import { FactoryViewport } from '../../../src/renderer/scenes/FactoryViewport';
import { FloorMaterialsWindow } from '../../../src/renderer/windows/FloorMaterialsWindow';
import { lastFrame } from '../../support/fake-factory-scene';
import { rectangularLevel } from '../../support/floor-fixtures';
import { sampleGarage } from '../../support/sample-facilities';

/**
 * The layout-mode floor tool and the Floor Materials window (plan Step 09A)
 * in jsdom. The selection shapes are pure functions; the viewport turns
 * clicks into a selection, previews the material in place (presentation
 * only), asks the worker for its quote, and orders exactly the rectangles it
 * shows, which the worker validates again. The scene is a recording fake.
 */

describe('floor selections', () => {
  it('a rectangle between two cells, corners included, either way round', () => {
    expect(rectBetween({ col: 4, row: 1 }, { col: 2, row: 3 })).toEqual({
      col: 2,
      row: 1,
      cols: 3,
      rows: 3,
    });
  });

  it('row runs merge into taller rectangles where they repeat', () => {
    expect(
      runsToRects([
        [0, 0, 4],
        [1, 0, 4],
        [2, 0, 2],
        [3, 0, 4],
      ]),
    ).toEqual([
      { col: 0, row: 0, cols: 4, rows: 2 },
      { col: 0, row: 2, cols: 2, rows: 1 },
      { col: 0, row: 3, cols: 4, rows: 1 },
    ]);
  });

  it('the whole level is every eligible cell; a selection keeps only eligible cells', () => {
    const level = {
      eligibleRuns: [
        [0, 0, 3],
        [1, 1, 3],
      ] as [number, number, number][],
    };
    expect(levelRects(level)).toEqual([
      { col: 0, row: 0, cols: 3, rows: 1 },
      { col: 1, row: 1, cols: 2, rows: 1 },
    ]);
    expect(selectionRuns(level, [{ col: 0, row: 0, cols: 2, rows: 2 }])).toEqual([
      [0, 0, 2],
      [1, 1, 2],
    ]);
  });

  it('a fill takes the 4-connected area of the same covering and stops at works', () => {
    // 6 × 4 cells: epoxy in the left 3 columns, the starting surface elsewhere.
    const cells = [];
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        cells.push({ col, row, materialId: 'epoxy-grey' });
      }
    }
    const level = rectangularLevel(3000, 2000, cells);
    const model = buildFloorModel(level, 'concrete-standard', ['concrete-standard', 'epoxy-grey']);
    expect(fillRects(model, new Set(), { col: 1, row: 1 })).toEqual([
      { col: 0, row: 0, cols: 3, rows: 4 },
    ]);
    expect(fillRects(model, new Set(), { col: 5, row: 0 })).toEqual([
      { col: 3, row: 0, cols: 3, rows: 4 },
    ]);
    // Cells under works (row 2 of the epoxy) are left out and cut the area.
    const blocked = new Set([2 * 6 + 0, 2 * 6 + 1, 2 * 6 + 2]);
    expect(fillRects(model, blocked, { col: 0, row: 0 })).toEqual([
      { col: 0, row: 0, cols: 3, rows: 2 },
    ]);
    expect(fillRects(model, blocked, { col: 0, row: 2 })).toEqual([]);
  });
});

const accepted: RequestOutcome = {
  kind: 'accepted',
  worldRevision: 3,
  atMs: '0',
  duplicate: false,
};

const quoted = (query: SimulationQuery): QueryResult =>
  query.kind === 'floorQuote'
    ? {
        kind: 'floorQuote',
        allowed: true,
        refusal: null,
        quote: {
          cells: 6,
          skippedCells: 0,
          replacedCells: 0,
          areaMm2: '1500000',
          replacedAreaMm2: '0',
          removals: [],
          installCents: '8250',
          removalCents: '0',
          totalCents: '8250',
          availableCents: '4000000',
          workDays: 1,
          completesOn: '1996-01-02',
        },
      }
    : {
        kind: 'placement',
        allowed: true,
        refusal: null,
        problems: [],
        footprint: null,
        zones: [],
        chargeCents: '0',
      };

function harness(answer: (query: SimulationQuery) => QueryResult = quoted) {
  const submitted: { type: string; payload: unknown }[] = [];
  const queries: SimulationQuery[] = [];
  const host = {
    pending: false,
    submit: (type: string, payload: unknown) => {
      submitted.push({ type, payload });
      return Promise.resolve(accepted);
    },
    query: (query: SimulationQuery) => {
      queries.push(query);
      return Promise.resolve(answer(query));
    },
  };
  return { host, submitted, queries };
}

function clientAt(xMm: number, yMm: number) {
  const plan = screen.getByTestId('facility-floor-plan');
  const ppm = Number(plan.getAttribute('data-pixels-per-metre'));
  const cx = Number(plan.getAttribute('data-camera-x-mm'));
  const cy = Number(plan.getAttribute('data-camera-y-mm'));
  return { clientX: ((xMm - cx) * ppm) / 1000, clientY: ((yMm - cy) * ppm) / 1000 };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The viewport in layout mode with the floor tool held in state, as the App holds it. */
function Viewport({
  facilities,
  property,
  host,
  initial,
}: {
  readonly facilities: FacilitiesView;
  readonly property: ReturnType<typeof sampleGarage>['property'];
  readonly host: ReturnType<typeof harness>['host'];
  readonly initial: FloorTool | null;
}) {
  const [tool, setTool] = useState<FloorTool | null>(initial);
  return (
    <FactoryViewport
      companyName="Layout Works"
      premises={property}
      units="metric"
      facilities={facilities}
      mode="layout"
      host={host}
      floorTool={tool}
      onFloorTool={setTool}
    />
  );
}

/** Click a cell's centre on the plan. */
function clickCell(col: number, row: number, shiftKey = false) {
  const plan = screen.getByTestId('facility-floor-plan');
  const at = clientAt(col * 500 + 250, row * 500 + 250);
  fireEvent.mouseMove(plan, at);
  fireEvent.click(plan, { ...at, shiftKey });
}

describe('the layout floor tool', () => {
  it('draws a rectangle between two clicks, previews it, prices it with the worker, and orders exactly it', async () => {
    const { property, facilities } = sampleGarage();
    const { host, queries, submitted } = harness();
    render(
      <Viewport
        facilities={facilities}
        property={property}
        host={host}
        initial={{ materialId: 'epoxy-grey', shape: 'rectangle' }}
      />,
    );
    await settle();
    expect(screen.getByTestId('floor-tool')).toHaveAttribute('data-material', 'epoxy-grey');
    clickCell(1, 10);
    expect(screen.getByTestId('floor-tool')).toHaveTextContent('Click the opposite corner.');
    clickCell(3, 11);
    await settle();
    // Asked once, for the rectangle as drawn (all six cells are eligible, the bottom row partial).
    const asked = queries.filter((query) => query.kind === 'floorQuote');
    expect(asked.at(-1)).toEqual({
      kind: 'floorQuote',
      propertyId: 'hf-canal-2',
      level: 0,
      materialId: 'epoxy-grey',
      rectangles: [{ col: 1, row: 10, cols: 3, rows: 2 }],
    });
    const quote = screen.getByTestId('floor-quote');
    expect(quote).toHaveAttribute('data-total', '8250');
    expect(quote).toHaveTextContent('6 cells, 1.50 m² of Industrial epoxy, grey: laying $82.50');
    expect(quote).toHaveTextContent('finishes on 1996-01-02 (1 day)');
    // The preview is presentation: the cells drawn in epoxy, outlined, nothing sent.
    const drawn = lastFrame().frame;
    expect(drawn.level.coverings).toEqual(
      expect.arrayContaining([
        [10, 1, 4, 'epoxy-grey', 'preview'],
        [11, 1, 4, 'epoxy-grey', 'preview'],
      ]),
    );
    expect(drawn.floorMarks?.selection).toEqual([
      [10, 1, 4],
      [11, 1, 4],
    ]);
    expect(drawn.floorMarks?.allowed).toBe(true);
    expect(submitted).toEqual([]);
    fireEvent.click(within(quote).getByRole('button', { name: 'Order floor works' }));
    await settle();
    expect(submitted).toEqual([
      {
        type: 'facility.installFloorCovering',
        payload: {
          propertyId: 'hf-canal-2',
          level: 0,
          materialId: 'epoxy-grey',
          rectangles: [{ col: 1, row: 10, cols: 3, rows: 2 }],
        },
      },
    ]);
    expect(screen.getByTestId('floor-quote')).toHaveTextContent('Nothing selected.');
  });

  it('single cells add with Shift, the whole level selects every eligible cell, Esc clears then closes', async () => {
    const { property, facilities } = sampleGarage();
    const { host, queries } = harness();
    render(
      <Viewport
        facilities={facilities}
        property={property}
        host={host}
        initial={{ materialId: 'steel-plate', shape: 'cell' }}
      />,
    );
    await settle();
    clickCell(0, 0);
    clickCell(2, 0, true);
    await settle();
    expect(queries.filter((query) => query.kind === 'floorQuote').at(-1)).toMatchObject({
      rectangles: [
        { col: 0, row: 0, cols: 1, rows: 1 },
        { col: 2, row: 0, cols: 1, rows: 1 },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Whole level' }));
    await settle();
    expect(queries.filter((query) => query.kind === 'floorQuote').at(-1)).toMatchObject({
      rectangles: [{ col: 0, row: 0, cols: 6, rows: 12 }],
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('floor-quote')).toHaveTextContent('Nothing selected.');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('floor-tool')).toBeNull();
  });

  it('shows the worker’s refusal, keeps Order disabled, and sends raw cells only when none is eligible', async () => {
    const { property, facilities } = sampleGarage();
    const { host, queries } = harness((query) =>
      query.kind === 'floorQuote'
        ? {
            kind: 'floorQuote',
            allowed: false,
            refusal: 'Insufficient funds: $10.00 available, $82.50 needed',
            quote: {
              cells: 6,
              skippedCells: 0,
              replacedCells: 0,
              areaMm2: '1500000',
              replacedAreaMm2: '0',
              removals: [],
              installCents: '8250',
              removalCents: '0',
              totalCents: '8250',
              availableCents: '1000',
              workDays: 1,
              completesOn: '1996-01-02',
            },
          }
        : quoted(query),
    );
    render(
      <Viewport
        facilities={facilities}
        property={property}
        host={host}
        initial={{ materialId: 'epoxy-grey', shape: 'cell' }}
      />,
    );
    await settle();
    clickCell(0, 0);
    await settle();
    const quote = screen.getByTestId('floor-quote');
    expect(quote).toHaveAttribute('data-allowed', 'false');
    expect(quote).toHaveTextContent('Insufficient funds: $10.00 available, $82.50 needed');
    expect(within(quote).getByRole('button', { name: 'Order floor works' })).toBeDisabled();
    expect(lastFrame().frame.floorMarks?.allowed).toBe(false);
    // The garage's grid is 6 × 12: every in-grid cell is eligible, so the clip keeps them.
    expect(queries.filter((query) => query.kind === 'floorQuote').at(-1)).toMatchObject({
      rectangles: [{ col: 0, row: 0, cols: 1, rows: 1 }],
    });
  });

  it('hatches cells under works in every mode and names the works in the cell inspector', async () => {
    const { property, facilities } = sampleGarage();
    const ground = facilities.premises?.levels[0];
    if (!facilities.premises || !ground) {
      throw new Error('no garage');
    }
    const withWorks: FacilitiesView = {
      ...facilities,
      premises: {
        ...facilities.premises,
        levels: [
          {
            ...ground,
            works: [
              {
                installationId: 'floor-installation:1',
                materialId: 'epoxy-grey',
                completesOn: '1996-01-03',
                runs: [[5, 0, 6]],
              },
            ],
          },
        ],
      },
    };
    const { host } = harness();
    const { rerender } = render(
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={withWorks}
        mode="operating"
        host={host}
      />,
    );
    await settle();
    expect(lastFrame().frame.floorMarks?.works).toEqual([[5, 0, 6]]);
    rerender(
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={withWorks}
        mode="layout"
        host={host}
      />,
    );
    fireEvent.mouseMove(screen.getByTestId('facility-floor-plan'), clientAt(2250, 2750));
    expect(screen.getByTestId('cell-info')).toHaveTextContent(
      'under works (floor-installation:1): Industrial epoxy, grey until 1996-01-03',
    );
  });
});

describe('Floor Materials window', () => {
  it('lists every material with its prices and a sample, and opens the floor tool with one', () => {
    const { facilities } = sampleGarage();
    const laid: FloorTool[] = [];
    render(
      <FloorMaterialsWindow
        facilities={facilities}
        units="metric"
        onLay={(tool) => laid.push(tool)}
        view={{}}
        onViewChange={() => undefined}
      />,
    );
    const epoxy = screen.getByTestId('floor-material-epoxy-grey');
    expect(epoxy).toHaveTextContent('Industrial epoxy, grey');
    expect(epoxy).toHaveTextContent('$55.00/m²');
    expect(epoxy).toHaveTextContent('$16.00/m²');
    expect(within(epoxy).getByTestId('floor-sample-epoxy-grey')).toBeInTheDocument();
    // The garage's own surface is not sold, and says so.
    const worn = screen.getByTestId('floor-material-concrete-worn');
    expect(worn).toHaveTextContent('Not sold');
    expect(worn).toHaveTextContent('(your existing floor)');
    fireEvent.click(within(epoxy).getByRole('button', { name: 'Lay in layout…' }));
    expect(laid).toEqual([{ materialId: 'epoxy-grey', shape: 'rectangle' }]);
  });

  it('lists the company’s floor orders with laying, taking up and the total', () => {
    const { facilities } = sampleGarage();
    const withOrders: FacilitiesView = {
      ...facilities,
      floorOrders: [
        {
          id: 'floor-installation:1',
          propertyId: 'hf-canal-2',
          address: '2 Canal Street (rear)',
          level: 0,
          materialId: 'steel-plate',
          kind: 'mixed',
          status: 'scheduled',
          orderedOn: '1996-01-05',
          completesOn: '1996-01-06',
          cells: 6,
          areaMm2: '1300000',
          replacedCells: 4,
          installCents: '23400',
          removalCents: '1280',
          costCents: '24680',
        },
      ],
    };
    render(
      <FloorMaterialsWindow
        facilities={withOrders}
        units="metric"
        onLay={() => undefined}
        view={{ tab: 'orders' }}
        onViewChange={() => undefined}
      />,
    );
    const row = screen.getByTestId('floor-order-floor-installation:1');
    expect(row).toHaveTextContent('Steel floor plate');
    expect(row).toHaveTextContent('Installation and replacement');
    expect(row).toHaveTextContent('1.30 m² (6 cells)');
    expect(row).toHaveTextContent('$234.00');
    expect(row).toHaveTextContent('$12.80');
    expect(row).toHaveTextContent('$246.80');
    expect(row).toHaveTextContent('Under way until 1996-01-06');
  });
});
