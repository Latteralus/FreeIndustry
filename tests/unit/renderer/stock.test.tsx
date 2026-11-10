import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { QueryResult, SimulationQuery } from '../../../src/shared/ipc/facilities';
import type { RequestOutcome } from '../../../src/renderer/app/useSimulationHost';
import { artBounds, placeArt } from '../../../src/renderer/scenes/factory/equipment-art';
import { buildSceneModel, hitTest } from '../../../src/renderer/scenes/factory/scene-model';
import { stockArt } from '../../../src/renderer/scenes/factory/stock-art';
import { FactoryViewport } from '../../../src/renderer/scenes/FactoryViewport';
import { StockWindow } from '../../../src/renderer/windows/StockWindow';
import { lastFrame } from '../../support/fake-factory-scene';
import { sampleStockedGarage } from '../../support/sample-stock';

/**
 * Step 10 in the renderer: load units in the factory scene at their exact
 * footprints, drawn top-down and fitted exactly to them; clicking one
 * selects it in every mode; and the Stock window shows its contents,
 * provenance and history from the worker, and classifies scrap through the
 * real command.
 */

const accepted: RequestOutcome = {
  kind: 'accepted',
  worldRevision: 2,
  atMs: '0',
  duplicate: false,
};

function fakeHost(answer: (query: SimulationQuery) => QueryResult) {
  const submitted: { type: string; payload: unknown }[] = [];
  return {
    submitted,
    host: {
      pending: false,
      submit: (type: string, payload: unknown) => {
        submitted.push({ type, payload });
        return Promise.resolve(accepted);
      },
      query: (query: SimulationQuery) => Promise.resolve(answer(query)),
    },
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function clientAt(xMm: number, yMm: number) {
  const plan = screen.getByTestId('facility-floor-plan');
  const ppm = Number(plan.getAttribute('data-pixels-per-metre'));
  const cx = Number(plan.getAttribute('data-camera-x-mm'));
  const cy = Number(plan.getAttribute('data-camera-y-mm'));
  return { clientX: ((xMm - cx) * ppm) / 1000, clientY: ((yMm - cy) * ppm) / 1000 };
}

describe('load units in the factory scene', () => {
  it('stand at their exact footprint on the stock layer and are selected by a point inside them', () => {
    const garage = sampleStockedGarage();
    const level = garage.facilities.premises?.levels[0];
    if (!level) {
      throw new Error('no level');
    }
    const scene = buildSceneModel(
      garage.property,
      level,
      garage.facilities,
      'hf-canal-2',
      garage.stock,
    );
    const pallet = scene.objects.find((object) => object.kind === 'load-unit');
    const unit = garage.stock.loadUnits[0];
    expect(unit?.location.kind).toBe('floor');
    expect(pallet).toMatchObject({
      id: unit?.id,
      layer: 'stock',
      rect: unit?.location.kind === 'floor' ? unit.location.rect : null,
      loadColour: '#3d5a73',
    });
    // Drawn above the structure and equipment, never sorted by screen y.
    expect(
      scene.objects.at(-1)?.kind === 'keep-clear' || scene.objects.at(-1)?.kind === 'load-unit',
    ).toBe(true);
    if (pallet?.kind === 'load-unit') {
      const { rect } = pallet;
      expect(hitTest(scene, rect.x + 1, rect.y + 1)?.id).toBe(pallet.id);
      expect(hitTest(scene, rect.x + rect.width, rect.y)).toBeNull();
    }
  });

  it('are drawn from above, filling exactly their footprint in every quarter turn', () => {
    const { stock } = sampleStockedGarage();
    for (const type of stock.containerTypes) {
      for (const rotation of [0, 90, 180, 270]) {
        const quarter = rotation % 180 !== 0;
        const footprint = {
          x: 1000,
          y: 2000,
          width: quarter ? type.outerMm.depth : type.outerMm.width,
          depth: quarter ? type.outerMm.width : type.outerMm.depth,
        };
        for (const loadColour of [null, '#3d5a73']) {
          const art = stockArt({
            kind: type.kind,
            widthMm: type.outerMm.width,
            depthMm: type.outerMm.depth,
            colour: type.colour,
            loadColour,
            childMm: null,
          });
          const placed = placeArt(
            art,
            { widthMm: type.outerMm.width, depthMm: type.outerMm.depth },
            footprint,
            rotation,
          );
          expect(artBounds(placed)).toEqual(footprint);
        }
      }
    }
  });

  it('are selected by clicking them on the floor, with a link to their record', async () => {
    const garage = sampleStockedGarage();
    const opened: string[] = [];
    const selected: (string | null)[] = [];
    const { host } = fakeHost(() => ({
      kind: 'floorQuote',
      allowed: false,
      refusal: 'unused',
      quote: null,
    }));
    render(
      <FactoryViewport
        companyName="Stock Works"
        premises={garage.property}
        units="metric"
        facilities={garage.facilities}
        stock={garage.stock}
        host={host}
        onSelect={(id) => selected.push(id)}
        onOpenStock={(id) => opened.push(id)}
      />,
    );
    await settle();
    expect(screen.getByTestId('facility-caption')).toHaveTextContent(
      '1 load unit of stock on the floor',
    );
    const unit = garage.stock.loadUnits[0];
    const rect = unit?.location.kind === 'floor' ? unit.location.rect : null;
    if (!rect || !unit) {
      throw new Error('no pallet');
    }
    expect(lastFrame().frame.scene.objects.some((object) => object.id === unit.id)).toBe(true);
    fireEvent.click(
      screen.getByTestId('facility-floor-plan'),
      clientAt(rect.x + 100, rect.y + 100),
    );
    expect(selected.at(-1)).toBe(unit.id);
    const record = screen.getByTestId('selection-record');
    expect(record).toHaveTextContent('Wooden pallet, 48 × 40 in (load-unit:1)');
    expect(record).toHaveTextContent('1 lot, 0 load units inside');
    fireEvent.click(within(record).getByRole('button', { name: 'Contents and provenance…' }));
    expect(opened).toEqual([unit.id]);
  });
});

describe('the Stock window', () => {
  it('lists load units, lots, the stock-take and receipts, all from the worker', () => {
    const garage = sampleStockedGarage();
    const { host } = fakeHost((query) =>
      query.kind === 'stockRecord' ? garage.record(query.id) : garage.record('load-unit:1'),
    );
    const { rerender } = render(
      <StockWindow
        stock={garage.stock}
        units="metric"
        host={host}
        selectedId={null}
        onSelect={() => undefined}
        onShow={() => undefined}
        view={{}}
        onViewChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('stock-unit-load-unit:1')).toHaveTextContent('6 each Electric motor');
    expect(screen.getByTestId('stock-unit-load-unit:1')).toHaveTextContent('75.6 kg');
    for (const tab of ['lots', 'count', 'receipts']) {
      rerender(
        <StockWindow
          stock={garage.stock}
          units="metric"
          host={host}
          selectedId={null}
          onSelect={() => undefined}
          onShow={() => undefined}
          view={{ tab }}
          onViewChange={() => undefined}
        />,
      );
    }
    expect(screen.getByTestId('stock-receipt-stock-receipt:1')).toHaveTextContent(
      'Diagnostic supplier',
    );
    expect(screen.getByTestId('stock-receipt-stock-receipt:1')).toHaveTextContent('$540.00');
  });

  it('shows the stock-take agreeing with the books', () => {
    const garage = sampleStockedGarage();
    const { host } = fakeHost((query) =>
      garage.record(query.kind === 'stockRecord' ? query.id : ''),
    );
    render(
      <StockWindow
        stock={garage.stock}
        units="us"
        host={host}
        selectedId={null}
        onSelect={() => undefined}
        onShow={() => undefined}
        view={{ tab: 'count' }}
        onViewChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('stock-count-motor-half-hp')).toHaveTextContent('None');
    expect(screen.getByTestId('stock-reconciliation')).toHaveTextContent(
      '1 lots in 1 load units cost $540.00; the Inventory account holds $540.00 (they agree).',
    );
  });

  it('shows a selected unit’s contents, serials, provenance and history, and scraps through the real command', async () => {
    const garage = sampleStockedGarage();
    const { host, submitted } = fakeHost((query) =>
      query.kind === 'stockRecord' ? garage.record(query.id) : garage.record(''),
    );
    render(
      <StockWindow
        stock={garage.stock}
        units="metric"
        host={host}
        selectedId="load-unit:1"
        onSelect={() => undefined}
        onShow={() => undefined}
        view={{}}
        onViewChange={() => undefined}
      />,
    );
    await settle();
    const record = screen.getByTestId('stock-record');
    expect(screen.getByTestId('stock-whereabouts')).toHaveTextContent(
      'the floor of 2 Canal Street (rear)',
    );
    expect(screen.getByTestId('stock-capacity')).toHaveTextContent(
      'Gross 75.6 kg; contents 54.6 kg of a 1,000.0 kg payload',
    );
    const lot = screen.getByTestId('stock-record-lot-lot:1');
    expect(lot).toHaveTextContent('6 each');
    expect(lot).toHaveTextContent(
      'Serials serial:1, serial:2, serial:3, serial:4, serial:5, serial:6',
    );
    expect(screen.getByTestId('stock-provenance-lot:1')).toHaveTextContent(
      'lot:1 received 1996-01-01 from Diagnostic supplier (stock-receipt:1, invoice:',
    );
    expect(within(screen.getByTestId('stock-history')).getByText(/Received/)).toBeInTheDocument();
    fireEvent.click(within(record).getByRole('button', { name: 'Scrap…' }));
    fireEvent.change(screen.getByLabelText(/Quantity/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'defective' } });
    fireEvent.click(screen.getByRole('button', { name: 'Classify as scrap' }));
    await settle();
    expect(submitted).toEqual([
      {
        type: 'stock.scrap',
        payload: { lotId: 'lot:1', quantityMicro: '2000000', serials: null, reason: 'defective' },
      },
    ]);
  });
});
