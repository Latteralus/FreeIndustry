import { useState } from 'react';
import type { EquipmentTypeView, FacilitiesView } from '../../shared/ipc/facilities';
import type { Units } from '../app/desktop/profile-store';
import { withSort, withTab, type WindowViewProps } from '../app/desktop/window-catalog';
import { formatCents } from '../app/money-input';
import { formatLength, USE_LABEL } from '../app/units';
import type { SimulationHostView } from '../app/useSimulationHost';
import { DataTable, type Column } from '../components/DataTable';
import { Tabs, selectedTab } from '../components/Tabs';
import type { LayoutTool } from '../scenes/FactoryViewport';

/**
 * Equipment Catalog (Catalog → Equipment Catalog; ledger OR-31, OR-32):
 * every equipment type with its spec sheet — footprint, height, weight,
 * power and services, permitted uses, price, rigging charge — and a plan
 * diagram of its footprint and zones drawn to scale; buying is the real
 * `equipment.purchase` command. The Owned tab lists the company's items,
 * where each stands, and starts installing, moving or removing one.
 */

type EquipmentType = EquipmentTypeView;
type Owned = FacilitiesView['equipment'][number];

const TABS = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'owned', label: 'Owned' },
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  machining: 'Machining',
  fabrication: 'Fabrication',
  woodworking: 'Woodworking',
  plastics: 'Plastics',
  finishing: 'Finishing',
  assembly: 'Assembly',
  'material-handling': 'Material handling',
  storage: 'Storage',
  office: 'Office',
  utility: 'Utility',
};

const ZONE_LABEL: Record<string, string> = {
  operator: 'operator station',
  maintenance: 'maintenance area',
  clearance: 'safety clearance',
  input: 'input port',
  output: 'output port',
};

const kva = (va: number) =>
  va === 0 ? 'none' : `${(va / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kVA`;

/** The type's footprint and zones, top-down, at a fixed 40 px a metre (never fitted to the box). */
function TypeDiagram({ type }: { readonly type: EquipmentType }) {
  const { footprint, zones } = type.shape;
  const all = [footprint, ...zones.map((zone) => zone.rect)];
  const minX = Math.min(...all.map((r) => r.x));
  const minY = Math.min(...all.map((r) => r.y));
  const maxX = Math.max(...all.map((r) => r.x + r.width));
  const maxY = Math.max(...all.map((r) => r.y + r.depth));
  const scale = 40 / 1000;
  const margin = 8;
  return (
    <svg
      className="equipment-diagram"
      width={(maxX - minX) * scale + margin * 2}
      height={(maxY - minY) * scale + margin * 2}
      role="img"
      aria-label={`Plan of the ${type.name}: footprint and zones, 40 px a metre, front at the bottom`}
      data-testid="equipment-diagram"
    >
      <g transform={`translate(${margin - minX * scale} ${margin - minY * scale}) scale(${scale})`}>
        {zones.map((zone, index) => (
          <rect
            key={index}
            className={`plan-zone plan-zone-${zone.kind}`}
            x={zone.rect.x}
            y={zone.rect.y}
            width={zone.rect.width}
            height={zone.rect.depth}
            vectorEffect="non-scaling-stroke"
          >
            <title>{ZONE_LABEL[zone.kind]}</title>
          </rect>
        ))}
        <rect
          className="plan-footprint"
          x={footprint.x}
          y={footprint.y}
          width={footprint.width}
          height={footprint.depth}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}

export interface EquipmentWindowProps extends WindowViewProps {
  readonly facilities: FacilitiesView | null;
  readonly hasCompany: boolean;
  readonly units: Units;
  readonly host: Pick<SimulationHostView, 'submit' | 'pending'>;
  /** Start placing an item in the factory viewport. */
  readonly onPlace: (tool: LayoutTool) => void;
  /** The entity selected on the factory floor, highlighted here (the same record in every view). */
  readonly selectedId?: string | null;
  /** Select an installed item on the floor and centre the view on it. */
  readonly onShow?: (id: string) => void;
}

export function EquipmentWindow({
  facilities,
  hasCompany,
  units,
  host,
  onPlace,
  selectedId = null,
  onShow,
  view,
  onViewChange,
}: EquipmentWindowProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  if (!facilities) {
    return (
      <div className="window-content">
        <p>
          This world was created before equipment existed (plan Step 08). Start a new company to buy
          and lay out equipment.
        </p>
      </div>
    );
  }
  const tab = selectedTab(TABS, view.tab);
  const type =
    facilities.equipmentTypes.find((candidate) => candidate.id === selectedType) ??
    facilities.equipmentTypes[0] ??
    null;
  const premises = facilities.premises;

  const typeColumns: Column<EquipmentType>[] = [
    { id: 'name', header: 'Equipment', sortValue: (row) => row.name, render: (row) => row.name },
    {
      id: 'category',
      header: 'Category',
      sortValue: (row) => row.category,
      render: (row) => CATEGORY_LABEL[row.category] ?? row.category,
    },
    {
      id: 'footprint',
      header: 'Footprint',
      sortValue: (row) => row.widthMm * row.depthMm,
      render: (row) => `${formatLength(row.widthMm, units)} × ${formatLength(row.depthMm, units)}`,
    },
    {
      id: 'power',
      header: 'Power',
      numeric: true,
      sortValue: (row) => row.powerVa,
      render: (row) => `${kva(row.powerVa)}${row.threePhase ? ', 3-phase' : ''}`,
    },
    {
      id: 'price',
      header: 'Price',
      numeric: true,
      sortValue: (row) => BigInt(row.priceCents),
      render: (row) => formatCents(row.priceCents),
    },
  ];

  const ownedColumns: Column<Owned>[] = [
    {
      id: 'id',
      header: 'Item',
      sortValue: (row) => Number(row.id.split(':')[1]),
      render: (row) => row.id,
    },
    { id: 'name', header: 'Equipment', sortValue: (row) => row.name, render: (row) => row.name },
    {
      id: 'status',
      header: 'Where',
      sortValue: (row) => row.status,
      render: (row) =>
        row.placement
          ? `Installed, ${row.placement.address} (${formatLength(row.placement.xMm, units)}, ${formatLength(row.placement.yMm, units)}, ${row.placement.rotation}°)`
          : `Uninstalled, held by ${row.supplier}`,
    },
    {
      id: 'bought',
      header: 'Bought',
      sortValue: (row) => row.purchasedOn,
      render: (row) => row.purchasedOn,
    },
    {
      id: 'actions',
      header: '',
      render: (row) =>
        row.placement ? (
          <>
            {onShow ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onShow(row.id);
                  }}
                >
                  Show on floor
                </button>{' '}
              </>
            ) : null}
            <button
              type="button"
              disabled={host.pending}
              onClick={() => {
                onPlace({
                  kind: 'move',
                  equipmentId: row.id,
                  typeId: row.typeId,
                  rotation: row.placement?.rotation ?? 0,
                });
              }}
            >
              Move…
            </button>{' '}
            <button
              type="button"
              disabled={host.pending}
              onClick={() => {
                void host.submit('equipment.uninstall', { equipmentId: row.id }).then((outcome) => {
                  setMessage(outcome?.kind === 'rejected' ? outcome.error.message : null);
                });
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={host.pending || !premises}
            title={premises ? undefined : 'Lease premises first'}
            onClick={() => {
              onPlace({ kind: 'install', equipmentId: row.id, typeId: row.typeId, rotation: 0 });
            }}
          >
            Install…
          </button>
        ),
    },
  ];

  return (
    <div className="window-content equipment-window">
      <Tabs
        idPrefix="equipment"
        label="Equipment"
        tabs={TABS}
        selected={tab}
        onSelect={(id) => {
          onViewChange(withTab(view, id));
        }}
      >
        {tab === 'catalog' ? (
          <div className="equipment-catalog">
            <DataTable
              label="Equipment types"
              columns={typeColumns}
              rows={facilities.equipmentTypes}
              rowKey={(row) => row.id}
              rowTestId={(row) => `equipment-type-${row.id}`}
              sort={view.sort ?? null}
              onSortChange={(sort) => {
                onViewChange(withSort(view, sort));
              }}
            />
            <label>
              Spec sheet{' '}
              <select
                value={type?.id ?? ''}
                onChange={(event) => {
                  setSelectedType(event.target.value);
                  setMessage(null);
                }}
              >
                {facilities.equipmentTypes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            {type ? (
              <div className="equipment-sheet" data-testid="equipment-sheet">
                <h3>{type.name}</h3>
                <p>{type.description}</p>
                <dl>
                  <dt>Footprint</dt>
                  <dd data-testid="sheet-footprint">
                    {formatLength(type.widthMm, units)} × {formatLength(type.depthMm, units)} (
                    {type.widthMm.toLocaleString('en-US')} × {type.depthMm.toLocaleString('en-US')}{' '}
                    mm)
                  </dd>
                  <dt>Height, weight</dt>
                  <dd>
                    {formatLength(type.heightMm, units)}, {type.weightKg.toLocaleString('en-US')} kg
                  </dd>
                  <dt>Power and services</dt>
                  <dd>
                    {kva(type.powerVa)}
                    {type.threePhase ? ', three-phase' : ''}
                    {type.water ? ', water' : ''}
                    {type.gas ? ', gas' : ''}
                  </dd>
                  <dt>Permitted uses</dt>
                  <dd>{type.uses.map((use) => USE_LABEL[use]).join(', ')}</dd>
                  <dt>Zones</dt>
                  <dd>
                    {type.zones.length === 0
                      ? 'none'
                      : type.zones
                          .map(
                            (zone) =>
                              `${ZONE_LABEL[zone.kind]} at the ${zone.side}, ${formatLength(zone.depthMm, units)} deep`,
                          )
                          .join('; ')}
                  </dd>
                  <dt>Dealer</dt>
                  <dd>{type.supplier}</dd>
                  <dt>Price</dt>
                  <dd data-testid="sheet-price">
                    {formatCents(type.priceCents)} delivered and installed; moving or reinstalling{' '}
                    {formatCents(type.relocationCents)}
                  </dd>
                </dl>
                <TypeDiagram type={type} />
                <div className="equipment-buy">
                  <label>
                    Quantity{' '}
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={quantity}
                      onChange={(event) => {
                        setQuantity(
                          Math.max(1, Math.min(20, Math.floor(Number(event.target.value) || 1))),
                        );
                      }}
                    />
                  </label>{' '}
                  <button
                    type="button"
                    disabled={!hasCompany || host.pending}
                    title={hasCompany ? undefined : 'Found a company first'}
                    onClick={() => {
                      void host
                        .submit('equipment.purchase', { equipmentTypeId: type.id, quantity })
                        .then((outcome) => {
                          setMessage(
                            outcome?.kind === 'rejected'
                              ? outcome.error.message
                              : outcome?.kind === 'accepted'
                                ? `Bought ${quantity} × ${type.name}. The dealer holds it until you install it (Owned tab).`
                                : null,
                          );
                        });
                    }}
                  >
                    Buy
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <DataTable
            label="Owned equipment"
            columns={ownedColumns}
            rows={facilities.equipment}
            rowKey={(row) => row.id}
            rowTestId={(row) => `owned-${row.id}`}
            rowProps={(row) => ({
              'data-selected': String(row.id === selectedId),
              className: row.id === selectedId ? 'row-selected' : '',
            })}
            emptyText="The company owns no equipment."
            sort={view.sort ?? null}
            onSortChange={(sort) => {
              onViewChange(withSort(view, sort));
            }}
          />
        )}
      </Tabs>
      {message ? (
        <p className="outcome" role="status" data-testid="equipment-outcome">
          {message}
        </p>
      ) : null}
    </div>
  );
}
