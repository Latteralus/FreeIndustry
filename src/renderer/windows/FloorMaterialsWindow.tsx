import type { FacilitiesView } from '../../shared/ipc/facilities';
import type { Units } from '../app/desktop/profile-store';
import { withSort, withTab, type WindowViewProps } from '../app/desktop/window-catalog';
import { formatCents } from '../app/money-input';
import { formatAreaPrecise } from '../app/units';
import { DataTable, type Column } from '../components/DataTable';
import { Tabs, selectedTab } from '../components/Tabs';
import type { FloorTool } from '../scenes/factory/floor-selection';

/**
 * Floor Materials (Catalog → Floor Materials; plan Step 09A, spec §5.6,
 * ledger OR-86): every material in the world's catalog with its category,
 * installation and removal prices per square metre and a sample of its
 * surface drawn to scale, and the company's floor orders with what each
 * cost and when the contractor finishes. Choosing "Lay in layout" opens the
 * floor tool in the factory view; the order itself is placed there, with
 * the worker's exact quote.
 */

type Material = FacilitiesView['floorMaterials'][number];
type Order = FacilitiesView['floorOrders'][number];

const TABS = [
  { id: 'materials', label: 'Materials' },
  { id: 'orders', label: 'Orders' },
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  concrete: 'Concrete',
  'polished-concrete': 'Polished concrete',
  'painted-concrete': 'Painted concrete',
  epoxy: 'Epoxy',
  'steel-plate': 'Steel plate',
  'diamond-plate': 'Diamond plate',
  'anti-slip': 'Anti-slip',
  'safety-marking': 'Safety marking',
  office: 'Office',
};

const KIND_LABEL: Record<Order['kind'], string> = {
  installation: 'Installation',
  replacement: 'Replacement',
  mixed: 'Installation and replacement',
};

const SQ_FT_PER_M2 = 0.09290304;

/** A price per m², with the per-square-foot figure for US units (display only). */
function perArea(cents: string, units: Units): string {
  const metric = `${formatCents(cents)}/m²`;
  if (units === 'metric') {
    return metric;
  }
  const perFoot = (Number(cents) * SQ_FT_PER_M2) / 100;
  return `${metric} (${perFoot.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}/sq ft)`;
}

/** Sample size, millimetres, and drawing scale: a fixed 40 px a metre, top-down. */
const SAMPLE_MM = { width: 2000, depth: 1500 };
const SAMPLE_SCALE = 40 / 1000;

/** A 2 × 1.5 m patch of the material from above, with its own joints, at 40 px a metre. */
function Sample({ material }: { readonly material: Material }) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = material.patternMm.x; x < SAMPLE_MM.width; x += material.patternMm.x) {
    xs.push(x);
  }
  for (let y = material.patternMm.y; y < SAMPLE_MM.depth; y += material.patternMm.y) {
    ys.push(y);
  }
  return (
    <svg
      className="floor-sample"
      width={SAMPLE_MM.width * SAMPLE_SCALE}
      height={SAMPLE_MM.depth * SAMPLE_SCALE}
      role="img"
      aria-label={`Sample of ${material.name}, 2 × 1.5 m at 40 px a metre`}
      data-testid={`floor-sample-${material.id}`}
    >
      <g transform={`scale(${SAMPLE_SCALE})`}>
        <rect width={SAMPLE_MM.width} height={SAMPLE_MM.depth} fill={material.colour} />
        {xs.map((x) => (
          <line
            key={`x${x}`}
            x1={x}
            y1={0}
            x2={x}
            y2={SAMPLE_MM.depth}
            className="floor-sample-joint"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {ys.map((y) => (
          <line
            key={`y${y}`}
            x1={0}
            y1={y}
            x2={SAMPLE_MM.width}
            y2={y}
            className="floor-sample-joint"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    </svg>
  );
}

export interface FloorMaterialsWindowProps extends WindowViewProps {
  readonly facilities: FacilitiesView | null;
  readonly units: Units;
  /** Open the floor tool in the factory's layout mode with this material. */
  readonly onLay: (tool: FloorTool) => void;
}

export function FloorMaterialsWindow({
  facilities,
  units,
  onLay,
  view,
  onViewChange,
}: FloorMaterialsWindowProps) {
  if (!facilities) {
    return (
      <div className="window-content">
        <p>
          This world was created before building layouts existed (plan Step 08). Start a new company
          to buy floor coverings.
        </p>
      </div>
    );
  }
  const tab = selectedTab(TABS, view.tab);
  const premises = facilities.premises;
  const nameOf = (id: string) =>
    facilities.floorMaterials.find((material) => material.id === id)?.name ?? id;

  const materialColumns: Column<Material>[] = [
    {
      id: 'sample',
      header: 'Sample',
      render: (row) => <Sample material={row} />,
    },
    {
      id: 'name',
      header: 'Material',
      sortValue: (row) => row.name,
      render: (row) => (
        <>
          <strong>{row.name}</strong>
          {premises?.surfaceMaterialId === row.id ? ' (your existing floor)' : null}
          <br />
          <span className="floor-material-description">{row.description}</span>
        </>
      ),
    },
    {
      id: 'category',
      header: 'Category',
      sortValue: (row) => row.category,
      render: (row) => CATEGORY_LABEL[row.category] ?? row.category,
    },
    {
      id: 'install',
      header: 'Laid',
      numeric: true,
      sortValue: (row) => (row.installCentsPerM2 === null ? -1n : BigInt(row.installCentsPerM2)),
      render: (row) =>
        row.installCentsPerM2 === null ? 'Not sold' : perArea(row.installCentsPerM2, units),
    },
    {
      id: 'removal',
      header: 'Taken up',
      numeric: true,
      sortValue: (row) => BigInt(row.removalCentsPerM2),
      render: (row) => perArea(row.removalCentsPerM2, units),
    },
    {
      id: 'actions',
      header: '',
      render: (row) =>
        row.installCentsPerM2 === null ? null : (
          <button
            type="button"
            disabled={!premises}
            title={premises ? undefined : 'Lease premises first'}
            onClick={() => {
              onLay({ materialId: row.id, shape: 'rectangle' });
            }}
          >
            Lay in layout…
          </button>
        ),
    },
  ];

  const orderColumns: Column<Order>[] = [
    {
      id: 'id',
      header: 'Order',
      sortValue: (row) => Number(row.id.split(':')[1]),
      render: (row) => row.id,
    },
    {
      id: 'ordered',
      header: 'Ordered',
      sortValue: (row) => row.orderedOn,
      render: (row) => row.orderedOn,
    },
    {
      id: 'where',
      header: 'Premises',
      sortValue: (row) => row.address,
      render: (row) => `${row.address}, level ${row.level}`,
    },
    {
      id: 'material',
      header: 'Material',
      sortValue: (row) => nameOf(row.materialId),
      render: (row) => nameOf(row.materialId),
    },
    {
      id: 'kind',
      header: 'Work',
      sortValue: (row) => row.kind,
      render: (row) => KIND_LABEL[row.kind],
    },
    {
      id: 'area',
      header: 'Area',
      numeric: true,
      sortValue: (row) => BigInt(row.areaMm2),
      render: (row) =>
        `${formatAreaPrecise(row.areaMm2, units)} (${row.cells.toLocaleString('en-US')} ${row.cells === 1 ? 'cell' : 'cells'})`,
    },
    {
      id: 'install',
      header: 'Laying',
      numeric: true,
      sortValue: (row) => BigInt(row.installCents),
      render: (row) => formatCents(row.installCents),
    },
    {
      id: 'removal',
      header: 'Taking up',
      numeric: true,
      sortValue: (row) => BigInt(row.removalCents),
      render: (row) => formatCents(row.removalCents),
    },
    {
      id: 'cost',
      header: 'Total',
      numeric: true,
      sortValue: (row) => BigInt(row.costCents),
      render: (row) => formatCents(row.costCents),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.completesOn,
      render: (row) =>
        row.status === 'scheduled'
          ? `Under way until ${row.completesOn}`
          : `Laid ${row.completesOn}`,
    },
  ];

  return (
    <div className="window-content floor-materials-window">
      <Tabs
        idPrefix="floor-materials"
        label="Floor materials"
        tabs={TABS}
        selected={tab}
        onSelect={(id) => {
          onViewChange(withTab(view, id));
        }}
      >
        {tab === 'materials' ? (
          <>
            <p>
              Prices are the floor contractor&rsquo;s, charged on the exact covered area: a partial
              cell costs only its share. Replacing an installed covering adds the price of taking up
              the old one. Work takes whole days, and the cells are out of use until it is done.
              Coverings change appearance and cost only; they never change the slab&rsquo;s load
              rating.
            </p>
            <DataTable
              label="Floor materials"
              columns={materialColumns}
              rows={facilities.floorMaterials}
              rowKey={(row) => row.id}
              rowTestId={(row) => `floor-material-${row.id}`}
              sort={view.sort ?? null}
              onSortChange={(sort) => {
                onViewChange(withSort(view, sort));
              }}
            />
          </>
        ) : (
          <DataTable
            label="Floor orders"
            columns={orderColumns}
            rows={facilities.floorOrders}
            rowKey={(row) => row.id}
            rowTestId={(row) => `floor-order-${row.id}`}
            emptyText="The company has placed no floor orders."
            sort={view.sort ?? null}
            onSortChange={(sort) => {
              onViewChange(withSort(view, sort));
            }}
          />
        )}
      </Tabs>
    </div>
  );
}
