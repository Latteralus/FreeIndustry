import { act, fireEvent, render, screen } from '@testing-library/react';
import type { QueryResult, SimulationQuery } from '../../../src/shared/ipc/facilities';
import type { RequestOutcome } from '../../../src/renderer/app/useSimulationHost';
import type { FactoryMode } from '../../../src/renderer/scenes/factory/camera';
import { FactoryViewport, type LayoutTool } from '../../../src/renderer/scenes/FactoryViewport';
import { EquipmentWindow } from '../../../src/renderer/windows/EquipmentWindow';
import { lastFrame } from '../../support/fake-factory-scene';
import { sampleGarage } from '../../support/sample-facilities';

/**
 * The factory viewport (Steps 08–09) and Equipment Catalog in jsdom. jsdom
 * has no GPU, so the PixiJS scene is a recording fake and these tests check
 * what the viewport hands it: the garage from the worker's read model, every
 * object at its exact footprint, the grid only in layout mode, one camera
 * and one selection across the three modes, the cell inspector, panning and
 * zooming without a command, and the placement tool asking the worker
 * before submitting the real command. The real drawing is measured in the
 * real app (`tests/e2e/factory-renderer.spec.ts`).
 */

const accepted: RequestOutcome = {
  kind: 'accepted',
  worldRevision: 2,
  atMs: '0',
  duplicate: false,
};

function fakeHost(answer: (query: SimulationQuery) => QueryResult) {
  const submitted: { type: string; payload: unknown }[] = [];
  const queries: SimulationQuery[] = [];
  return {
    submitted,
    queries,
    host: {
      pending: false,
      submit: (type: string, payload: unknown) => {
        submitted.push({ type, payload });
        return Promise.resolve(accepted);
      },
      query: (query: SimulationQuery) => {
        queries.push(query);
        return Promise.resolve(answer(query));
      },
    },
  };
}

const allowed = (query: SimulationQuery): QueryResult => ({
  kind: 'placement',
  allowed: true,
  refusal: null,
  problems: [],
  footprint: { x: query.xMm, y: query.yMm, width: 450, depth: 1200 },
  zones: [],
  chargeCents: '0',
});

/** Where a world point is on the canvas host, from the camera it reports (jsdom has no layout: a 0 × 0 viewport). */
function clientAt(xMm: number, yMm: number) {
  const plan = screen.getByTestId('facility-floor-plan');
  const ppm = Number(plan.getAttribute('data-pixels-per-metre'));
  const cx = Number(plan.getAttribute('data-camera-x-mm'));
  const cy = Number(plan.getAttribute('data-camera-y-mm'));
  return { clientX: ((xMm - cx) * ppm) / 1000, clientY: ((yMm - cy) * ppm) / 1000 };
}

/** Let the scene factory's promise resolve. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('factory layout view', () => {
  it('hands the scene the garage from its geometry: the bench exactly to its footprint, the grid only in layout mode, at any zoom', async () => {
    const { property, facilities } = sampleGarage();
    const { host } = fakeHost(allowed);
    const view = (mode: FactoryMode) => (
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={facilities}
        mode={mode}
        host={host}
      />
    );
    const { rerender } = render(view('operating'));
    await settle();
    expect(screen.getByTestId('facility-caption')).toHaveTextContent(
      '1 item of equipment installed (idle until production, Step 13); no staff or stock',
    );
    expect(screen.getByTestId('level-area')).toHaveTextContent(
      'Ground floor: usable 17.4 m² of 17.4 m²; 72 cells (66 full, 6 partial, 0 outside)',
    );
    // No grid outside layout mode.
    let drawn = lastFrame();
    expect(drawn.frame.mode).toBe('operating');
    expect([drawn.frame.showGrid, drawn.frame.showSubGrid]).toEqual([false, false]);
    const bench = drawn.frame.scene.objects.find((object) => object.id === 'equipment:1');
    expect(bench).toMatchObject({ rect: { x: 0, y: 0, width: 1800, depth: 750 } });
    // Centred on the floor at 10 px a metre.
    expect(drawn.camera).toEqual({ centreXMm: 1500, centreYMm: 2900, zoomIndex: 2 });
    rerender(view('layout'));
    drawn = lastFrame();
    expect([drawn.frame.mode, drawn.frame.showGrid, drawn.frame.showSubGrid]).toEqual([
      'layout',
      true,
      false,
    ]);
    // Zooming changes pixels per metre only; the footprint stays in millimetres.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    drawn = lastFrame();
    expect(screen.getByTestId('facility-floor-plan')).toHaveAttribute(
      'data-pixels-per-metre',
      '20',
    );
    expect(drawn.camera).toEqual({ centreXMm: 1500, centreYMm: 2900, zoomIndex: 3 });
    expect(drawn.frame.scene.objects.find((object) => object.id === 'equipment:1')).toEqual(bench);
    // The 250 mm sub-grid on demand.
    fireEvent.click(screen.getByLabelText('250 mm sub-grid and snap'));
    expect(lastFrame().frame.showSubGrid).toBe(true);
  });

  it('every mode draws the same entities with the same camera, and selects the same machine', async () => {
    const { property, facilities } = sampleGarage();
    const modes: FactoryMode[] = [];
    const selections: (string | null)[] = [];
    let mode: FactoryMode = 'operating';
    const host = fakeHost(allowed).host;
    const view = () => (
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={facilities}
        mode={mode}
        onMode={(next) => {
          modes.push(next);
          mode = next;
        }}
        onSelect={(id) => selections.push(id)}
        host={host}
      />
    );
    const { rerender } = render(view());
    await settle();
    // Zoom once; then switch modes: the camera stays where it is.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const camera = lastFrame().camera;
    const objects = lastFrame().frame.scene.objects;
    for (const next of ['Layout', 'Inspection', 'Operating'] as const) {
      fireEvent.click(screen.getByRole('button', { name: next }));
      rerender(view());
      const drawn = lastFrame();
      expect(drawn.camera).toEqual(camera);
      expect(drawn.frame.scene.objects).toEqual(objects);
      // Clicking the bench selects the same entity in every mode.
      fireEvent.click(screen.getByTestId('facility-floor-plan'), clientAt(900, 375));
      expect(lastFrame().frame.selectedId).toBe('equipment:1');
      expect(screen.getByTestId('selection-record')).toHaveAttribute(
        'data-entity-id',
        'equipment:1',
      );
    }
    expect(modes).toEqual(['layout', 'inspection', 'operating']);
    expect(selections).toEqual(['equipment:1', 'equipment:1', 'equipment:1']);
    // Clicking bare floor clears the selection.
    fireEvent.click(screen.getByTestId('facility-floor-plan'), clientAt(2500, 5000));
    expect(lastFrame().frame.selectedId).toBeNull();
  });

  it('the cell inspector reads the worker’s cells: full, partial and outside', async () => {
    const { property, facilities } = sampleGarage();
    render(
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={facilities}
        mode="layout"
        host={fakeHost(allowed).host}
      />,
    );
    await settle();
    const plan = screen.getByTestId('facility-floor-plan');
    fireEvent.mouseMove(plan, clientAt(2700, 5700));
    expect(screen.getByTestId('cell-info')).toHaveTextContent(
      'Cell (5, 11): partial, 0.2 m² · Worn concrete',
    );
    fireEvent.mouseMove(plan, clientAt(2000, 2000));
    expect(screen.getByTestId('cell-info')).toHaveTextContent(
      'Cell (4, 4): full, 0.3 m² · Worn concrete',
    );
  });

  it('placing: the preview follows the lattice, the worker is asked, a click submits the real command', async () => {
    const { property, facilities } = sampleGarage();
    const { host, queries, submitted } = fakeHost(allowed);
    let tool: LayoutTool | null = {
      kind: 'install',
      equipmentId: 'equipment:2',
      typeId: 'steel-shelving',
      rotation: 0,
    };
    const onTool = (next: LayoutTool | null) => {
      tool = next;
    };
    const view = () => (
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={facilities}
        mode="layout"
        tool={tool}
        onTool={onTool}
        host={host}
      />
    );
    const { rerender } = render(view());
    await settle();
    const plan = screen.getByTestId('facility-floor-plan');
    await act(async () => {
      // Pointer at (2,000, 2,000) mm: the 1,200 × 450 shelf centred there snaps to (1,500, 2,000).
      fireEvent.mouseMove(plan, clientAt(2000, 2000));
      await Promise.resolve();
    });
    expect(queries.at(-1)).toEqual({
      kind: 'placement',
      equipmentTypeId: 'steel-shelving',
      equipmentId: 'equipment:2',
      propertyId: 'hf-canal-2',
      level: 0,
      xMm: 1500,
      yMm: 2000,
      rotation: 0,
    });
    expect(screen.getByTestId('placement-ghost')).toHaveAttribute('data-allowed', 'true');
    expect(screen.getByTestId('placement-verdict')).toHaveTextContent('Allowed.');
    // The scene draws the worker's own footprint for the preview.
    expect(lastFrame().frame.preview?.footprint).toEqual({
      x: 1500,
      y: 2000,
      width: 450,
      depth: 1200,
    });
    // R turns it a quarter.
    fireEvent.keyDown(window, { key: 'r' });
    expect(tool).toMatchObject({ rotation: 90 });
    rerender(view());
    await act(async () => {
      fireEvent.click(plan, clientAt(2000, 2000));
      await Promise.resolve();
    });
    expect(submitted).toEqual([
      {
        type: 'equipment.install',
        payload: {
          equipmentId: 'equipment:2',
          propertyId: 'hf-canal-2',
          level: 0,
          xMm: 2000,
          yMm: 1500,
          rotation: 90,
        },
      },
    ]);
    expect(tool).toBeNull();
  });

  it('shows the worker’s reasons and the colliding rectangles when a placement is refused', async () => {
    const { property, facilities } = sampleGarage();
    const { host } = fakeHost((query) => ({
      ...allowed(query),
      allowed: false,
      problems: [
        {
          code: 'equipment',
          message: 'The Steel shelving unit overlaps the Steel workbench (equipment:1)',
          rect: { x: 0, y: 0, width: 1200, depth: 450 },
        },
      ],
    }));
    render(
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={facilities}
        mode="layout"
        tool={{
          kind: 'install',
          equipmentId: 'equipment:2',
          typeId: 'steel-shelving',
          rotation: 0,
        }}
        onTool={() => undefined}
        host={host}
      />,
    );
    await settle();
    await act(async () => {
      fireEvent.mouseMove(screen.getByTestId('facility-floor-plan'), clientAt(500, 500));
      await Promise.resolve();
    });
    expect(screen.getByTestId('placement-ghost')).toHaveAttribute('data-allowed', 'false');
    expect(lastFrame().frame.preview?.problems[0]?.rect).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      depth: 450,
    });
    expect(screen.getByTestId('placement-verdict')).toHaveTextContent(
      'Not allowed: The Steel shelving unit overlaps the Steel workbench (equipment:1)',
    );
  });

  it('pans by dragging and zooms with the wheel or the keyboard, without a command', async () => {
    const { property, facilities } = sampleGarage();
    const { host, submitted, queries } = fakeHost(allowed);
    render(
      <FactoryViewport
        companyName="Layout Works"
        premises={property}
        units="metric"
        facilities={facilities}
        host={host}
      />,
    );
    await settle();
    const plan = screen.getByTestId('facility-floor-plan');
    fireEvent.mouseDown(plan, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.mouseMove(window, { clientX: 10, clientY: -20 });
    fireEvent.mouseUp(window, { clientX: 10, clientY: -20 });
    // 10 px a metre: the floor follows the pointer 1 m east and 2 m north.
    expect(lastFrame().camera).toEqual({ centreXMm: 500, centreYMm: 4900, zoomIndex: 2 });
    fireEvent.wheel(plan, { deltaY: -100, clientX: 0, clientY: 0 });
    expect(lastFrame().camera).toEqual({ centreXMm: 500, centreYMm: 4900, zoomIndex: 3 });
    fireEvent.keyDown(plan, { key: '-' });
    expect(lastFrame().camera.zoomIndex).toBe(2);
    expect(submitted).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe('Equipment Catalog window', () => {
  it('shows each spec sheet with its exact footprint, buys through a command and starts an installation', async () => {
    const { facilities } = sampleGarage();
    const { host, submitted } = fakeHost(allowed);
    const placed: LayoutTool[] = [];
    const view = { tab: 'catalog' };
    const { rerender } = render(
      <EquipmentWindow
        facilities={facilities}
        hasCompany
        units="us"
        host={host}
        onPlace={(tool) => placed.push(tool)}
        view={view}
        onViewChange={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Spec sheet'), {
      target: { value: 'sliding-table-panel-saw' },
    });
    expect(screen.getByTestId('sheet-footprint')).toHaveTextContent(
      '12 ft × 6 ft (3,658 × 1,829 mm)',
    );
    expect(screen.getByTestId('equipment-diagram')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
      await Promise.resolve();
    });
    expect(submitted).toEqual([
      {
        type: 'equipment.purchase',
        payload: { equipmentTypeId: 'sliding-table-panel-saw', quantity: 2 },
      },
    ]);
    rerender(
      <EquipmentWindow
        facilities={facilities}
        hasCompany
        units="us"
        host={host}
        onPlace={(tool) => placed.push(tool)}
        view={{ tab: 'owned' }}
        onViewChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('owned-equipment:2')).toHaveTextContent(
      'Uninstalled, held by Midwest Shop Equipment',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Install…' }));
    expect(placed).toEqual([
      { kind: 'install', equipmentId: 'equipment:2', typeId: 'steel-shelving', rotation: 0 },
    ]);
  });

  it('highlights the item selected on the floor, and shows an installed item on the floor', () => {
    const { facilities } = sampleGarage();
    const shown: string[] = [];
    render(
      <EquipmentWindow
        facilities={facilities}
        hasCompany
        units="metric"
        host={fakeHost(allowed).host}
        onPlace={() => undefined}
        selectedId="equipment:1"
        onShow={(id) => shown.push(id)}
        view={{ tab: 'owned' }}
        onViewChange={() => undefined}
      />,
    );
    expect(screen.getByTestId('owned-equipment:1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('owned-equipment:2')).toHaveAttribute('data-selected', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Show on floor' }));
    expect(shown).toEqual(['equipment:1']);
  });
});
