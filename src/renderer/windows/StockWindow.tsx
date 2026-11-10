import { useEffect, useState } from 'react';
import { SCRAP_REASONS } from '../../shared/ipc/commands';
import type {
  LoadUnitView,
  LotView,
  ProductView,
  StockRecordResult,
  StockView,
} from '../../shared/ipc/stock';
import type { Units } from '../app/desktop/profile-store';
import { withSort, withTab, type WindowViewProps } from '../app/desktop/window-catalog';
import { formatCents } from '../app/money-input';
import { formatMass, formatQuantity, formatVolume, parseQuantity } from '../app/units';
import type { SimulationHostView } from '../app/useSimulationHost';
import { DataTable, type Column } from '../components/DataTable';
import { Tabs, selectedTab } from '../components/Tabs';

/**
 * Stock (Operations → Stock; plan Step 10, spec §3.4, §5.3, §5.5): every
 * load unit the company holds and where it is, every lot, a stock-take that
 * counts the physical stacks against the lots, and the receipts that brought
 * the goods in. Selecting a load unit, here or on the factory floor, shows
 * its record: what is in and on it, how full it is, where each lot came
 * from, and every movement that concerns it. Everything shown comes from
 * the worker; the window computes no stock fact. Classifying a quantity as
 * scrap is a real command, written down through the books.
 */

type Count = StockView['count'][number];
type Receipt = StockView['receipts'][number];
type RecordLot = StockRecordResult['lots'][number];

const TABS = [
  { id: 'units', label: 'Load units' },
  { id: 'lots', label: 'Lots' },
  { id: 'count', label: 'Stock-take' },
  { id: 'receipts', label: 'Receipts' },
] as const;

const KIND_LABEL: Record<string, string> = {
  receipt: 'Received',
  transfer: 'Transferred',
  split: 'Split',
  merge: 'Merged',
  relocation: 'Moved',
  scrap: 'Classified as scrap',
  loss: 'Lost',
};

const ORIGIN_LABEL: Record<RecordLot['lineage'][number]['origin'], string> = {
  receipt: 'received',
  split: 'split off',
  merge: 'merged',
};

const ordinal = (id: string) => Number(id.slice(id.indexOf(':') + 1));
const percent = (part: string, whole: string) =>
  whole === '0' ? '—' : `${Math.round((Number(part) / Number(whole)) * 100)}%`;

export interface StockWindowProps extends WindowViewProps {
  readonly stock: StockView | null;
  readonly units: Units;
  readonly host: Pick<SimulationHostView, 'query' | 'submit' | 'pending'>;
  /** The selected entity, shared with the factory view. */
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  /** Select a load unit standing on the floor and centre the factory view on it. */
  readonly onShow: (id: string) => void;
}

export function StockWindow({
  stock,
  units,
  host,
  selectedId,
  onSelect,
  onShow,
  view,
  onViewChange,
}: StockWindowProps) {
  if (!stock) {
    return (
      <div className="window-content">
        <p>
          This world was created before physical stock existed (plan Step 10). Start a new company
          to receive goods.
        </p>
      </div>
    );
  }
  const tab = selectedTab(TABS, view.tab);
  const products = new Map(stock.products.map((product) => [product.id, product]));
  const unitsById = new Map(stock.loadUnits.map((unit) => [unit.id, unit]));
  const productName = (id: string) => products.get(id)?.name ?? id;
  const quantity = (productId: string, micro: string) => {
    const product = products.get(productId);
    return product ? formatQuantity(product, micro, units) : micro;
  };
  const where = (unit: LoadUnitView) =>
    unit.location.kind === 'floor'
      ? `${unit.location.address}, level ${unit.location.level}${unit.location.held ? '' : ' (lease ended)'}`
      : unit.location.kind === 'load-unit'
        ? `on ${unit.location.loadUnitId}`
        : `${unit.location.equipmentId}, port ${unit.location.zone}`;
  const contents = (unit: LoadUnitView) => {
    const lots = stock.lots.filter((lot) => lot.loadUnitId === unit.id);
    const parts = lots.map(
      (lot) => `${quantity(lot.productId, lot.quantityMicro)} ${productName(lot.productId)}`,
    );
    if (unit.childIds.length > 0) {
      parts.push(`${unit.childIds.length} ${unit.childIds.length === 1 ? 'unit' : 'units'}`);
    }
    return parts.length === 0 ? 'Empty' : parts.join('; ');
  };
  const openButton = (id: string) => (
    <button
      type="button"
      onClick={() => {
        onSelect(id);
      }}
    >
      Record
    </button>
  );

  const unitColumns: Column<LoadUnitView>[] = [
    { id: 'id', header: 'Unit', sortValue: (row) => ordinal(row.id), render: (row) => row.id },
    { id: 'type', header: 'Container', sortValue: (row) => row.name, render: (row) => row.name },
    { id: 'where', header: 'Where', sortValue: (row) => where(row), render: (row) => where(row) },
    { id: 'contents', header: 'Contents', render: (row) => contents(row) },
    {
      id: 'mass',
      header: 'Gross',
      numeric: true,
      sortValue: (row) => BigInt(row.grossMassMg),
      render: (row) => formatMass(row.grossMassMg, units),
    },
    {
      id: 'load',
      header: 'Load',
      numeric: true,
      render: (row) =>
        `${percent(row.contentsMassMg, row.payloadMassMg)} by mass, ${percent(row.contentsVolumeMm3, row.volumeMm3)} by volume`,
    },
    { id: 'open', header: '', render: (row) => openButton(row.id) },
  ];

  const lotColumns: Column<LotView>[] = [
    { id: 'id', header: 'Lot', sortValue: (row) => ordinal(row.id), render: (row) => row.id },
    {
      id: 'product',
      header: 'Product',
      sortValue: (row) => productName(row.productId),
      render: (row) => productName(row.productId),
    },
    { id: 'grade', header: 'Grade', sortValue: (row) => row.grade, render: (row) => row.grade },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      sortValue: (row) => BigInt(row.quantityMicro),
      render: (row) => quantity(row.productId, row.quantityMicro),
    },
    {
      id: 'cost',
      header: 'Cost',
      numeric: true,
      sortValue: (row) => BigInt(row.costCents),
      render: (row) => formatCents(row.costCents),
    },
    {
      id: 'state',
      header: 'Disposition',
      sortValue: (row) => row.disposition,
      render: (row) =>
        `${row.disposition === 'scrap' ? 'Scrap' : 'Available'}${row.reservedMicro === '0' ? '' : `, ${quantity(row.productId, row.reservedMicro)} reserved`}`,
    },
    {
      id: 'in',
      header: 'In',
      sortValue: (row) => ordinal(row.loadUnitId),
      render: (row) => row.loadUnitId,
    },
    { id: 'open', header: '', render: (row) => openButton(row.loadUnitId) },
  ];

  const countColumns: Column<Count>[] = [
    {
      id: 'where',
      header: 'Premises',
      sortValue: (row) => row.address ?? '',
      render: (row) => row.address ?? 'At machines',
    },
    {
      id: 'product',
      header: 'Product',
      sortValue: (row) => productName(row.productId),
      render: (row) => productName(row.productId),
    },
    {
      id: 'counted',
      header: 'Counted',
      numeric: true,
      render: (row) => quantity(row.productId, row.countedMicro),
    },
    {
      id: 'recorded',
      header: 'Recorded',
      numeric: true,
      render: (row) => quantity(row.productId, row.recordedMicro),
    },
    {
      id: 'difference',
      header: 'Difference',
      numeric: true,
      render: (row) => (row.countedMicro === row.recordedMicro ? 'None' : 'MISMATCH'),
    },
    {
      id: 'scrap',
      header: 'Of which scrap',
      numeric: true,
      render: (row) => (row.scrapMicro === '0' ? '—' : quantity(row.productId, row.scrapMicro)),
    },
    {
      id: 'lots',
      header: 'Lots',
      numeric: true,
      render: (row) => row.lots.toLocaleString('en-US'),
    },
    { id: 'mass', header: 'Mass', numeric: true, render: (row) => formatMass(row.massMg, units) },
    { id: 'cost', header: 'Cost', numeric: true, render: (row) => formatCents(row.costCents) },
  ];

  const receiptColumns: Column<Receipt>[] = [
    { id: 'id', header: 'Receipt', sortValue: (row) => ordinal(row.id), render: (row) => row.id },
    {
      id: 'date',
      header: 'Received',
      sortValue: (row) => row.receivedOn,
      render: (row) => row.receivedOn,
    },
    { id: 'supplier', header: 'From', render: (row) => row.supplier },
    { id: 'product', header: 'Product', render: (row) => productName(row.productId) },
    {
      id: 'quantity',
      header: 'Quantity',
      numeric: true,
      render: (row) => quantity(row.productId, row.quantityMicro),
    },
    {
      id: 'units',
      header: 'Load units',
      numeric: true,
      render: (row) =>
        `${row.loadUnitCount} (${row.lotCount} ${row.lotCount === 1 ? 'lot' : 'lots'})`,
    },
    { id: 'where', header: 'Door', render: (row) => `${row.address}, door ${row.doorIndex + 1}` },
    { id: 'cost', header: 'Cost', numeric: true, render: (row) => formatCents(row.costCents) },
    { id: 'invoice', header: 'Invoice', render: (row) => row.invoiceId },
  ];

  const reconciled = stock.totals.costCents === stock.totals.inventoryCents;
  const selectedUnit = selectedId ? unitsById.get(selectedId) : undefined;

  return (
    <div className="window-content stock-window">
      <Tabs
        idPrefix="stock"
        label="Stock"
        tabs={TABS}
        selected={tab}
        onSelect={(id) => {
          onViewChange(withTab(view, id));
        }}
      >
        {tab === 'units' ? (
          <DataTable
            label="Load units"
            columns={unitColumns}
            rows={stock.loadUnits}
            rowKey={(row) => row.id}
            rowTestId={(row) => `stock-unit-${row.id}`}
            rowProps={(row) => (row.id === selectedId ? { 'aria-selected': 'true' } : {})}
            emptyText="The company holds no stock. Goods arrive with purchasing (plan Step 14); until then, Simulation Diagnostics can make a test delivery."
            sort={view.sort ?? null}
            onSortChange={(sort) => {
              onViewChange(withSort(view, sort));
            }}
          />
        ) : tab === 'lots' ? (
          <DataTable
            label="Lots"
            columns={lotColumns}
            rows={stock.lots}
            rowKey={(row) => row.id}
            rowTestId={(row) => `stock-lot-${row.id}`}
            emptyText="The company holds no lots."
            sort={view.sort ?? null}
            onSortChange={(sort) => {
              onViewChange(withSort(view, sort));
            }}
          />
        ) : tab === 'count' ? (
          <>
            <p>
              Counted walks every load unit standing on a floor and everything in and on it;
              recorded sums the lots. Nothing leaves the stock without a recorded movement, so the
              two always agree.
            </p>
            <DataTable
              label="Stock-take"
              columns={countColumns}
              rows={stock.count}
              rowKey={(row) => `${row.propertyId ?? ''}|${row.productId}`}
              rowTestId={(row) => `stock-count-${row.productId}`}
              emptyText="Nothing to count."
            />
            <p data-testid="stock-reconciliation">
              {stock.totals.lots.toLocaleString('en-US')} lots in{' '}
              {stock.totals.loadUnits.toLocaleString('en-US')} load units cost{' '}
              {formatCents(stock.totals.costCents)}; the Inventory account holds{' '}
              {formatCents(stock.totals.inventoryCents)}
              {reconciled ? ' (they agree).' : ' (THEY DISAGREE).'}
            </p>
          </>
        ) : (
          <DataTable
            label="Receipts"
            columns={receiptColumns}
            rows={stock.receipts}
            rowKey={(row) => row.id}
            rowTestId={(row) => `stock-receipt-${row.id}`}
            emptyText="No goods have been received."
          />
        )}
      </Tabs>
      {selectedUnit ? (
        <StockRecord
          key={selectedUnit.id}
          unit={selectedUnit}
          stock={stock}
          products={products}
          units={units}
          host={host}
          onSelect={onSelect}
          onShow={onShow}
        />
      ) : (
        <p className="stock-record-hint">
          Select a load unit (Record, or click it on the factory floor) to see its contents,
          provenance and history.
        </p>
      )}
    </div>
  );
}

interface StockRecordProps {
  readonly unit: LoadUnitView;
  readonly stock: StockView;
  readonly products: ReadonlyMap<string, ProductView>;
  readonly units: Units;
  readonly host: Pick<SimulationHostView, 'query' | 'submit' | 'pending'>;
  readonly onSelect: (id: string | null) => void;
  readonly onShow: (id: string) => void;
}

/** One load unit's record, asked of the worker whenever the stock changes. */
function StockRecord({ unit, stock, products, units, host, onSelect, onShow }: StockRecordProps) {
  const [record, setRecord] = useState<StockRecordResult | null>(null);
  const [scrapping, setScrapping] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<(typeof SCRAP_REASONS)[number]>('damaged');
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void host.query({ kind: 'stockRecord', id: unit.id }).then((result) => {
      if (current && result?.kind === 'stockRecord') {
        setRecord(result);
      }
    });
    return () => {
      current = false;
    };
    // Ask again whenever the worker sends new stock (`stock` is a new object each time).
  }, [host, unit.id, stock]);
  const product = (id: string) => products.get(id);
  const quantity = (productId: string, micro: string) => {
    const found = product(productId);
    return found ? formatQuantity(found, micro, units) : micro;
  };
  const scrap = async (lot: RecordLot) => {
    const quantityMicro = parseQuantity(amount);
    if (!quantityMicro) {
      setMessage(`Enter a quantity of ${product(lot.productId)?.unit ?? 'units'}`);
      return;
    }
    const outcome = await host.submit('stock.scrap', {
      lotId: lot.id,
      quantityMicro,
      serials: null,
      reason,
    });
    if (outcome?.kind === 'accepted') {
      setMessage(null);
      setScrapping(null);
      setAmount('');
    } else if (outcome?.kind === 'rejected') {
      setMessage(outcome.error.message);
    }
  };
  const children = unit.childIds
    .map((id) => stock.loadUnits.find((candidate) => candidate.id === id))
    .filter((child): child is LoadUnitView => child !== undefined);

  return (
    <section
      className="stock-record"
      aria-label={`Record of ${unit.id}`}
      data-testid="stock-record"
      data-entity-id={unit.id}
    >
      <h3>
        {unit.name} ({unit.id})
      </h3>
      <p data-testid="stock-whereabouts">
        At {record?.whereabouts ?? '…'}
        {unit.location.kind === 'floor' ? (
          <>
            {' '}
            <button
              type="button"
              onClick={() => {
                onShow(unit.id);
              }}
            >
              Show on floor
            </button>
          </>
        ) : unit.rootId !== unit.id ? (
          <>
            {' '}
            <button
              type="button"
              onClick={() => {
                onSelect(unit.rootId);
              }}
            >
              Open {unit.rootId}
            </button>
          </>
        ) : null}
      </p>
      <p data-testid="stock-capacity">
        Gross {formatMass(unit.grossMassMg, units)}; contents{' '}
        {formatMass(unit.contentsMassMg, units)} of a {formatMass(unit.payloadMassMg, units)}{' '}
        payload; {formatVolume(unit.contentsVolumeMm3, units)} of{' '}
        {formatVolume(unit.volumeMm3, units)} space. Received {unit.receivedOn}
        {unit.receiptId ? ` (${unit.receiptId})` : ''}.
      </p>
      {children.length > 0 ? (
        <>
          <h4>Carries</h4>
          <ul className="stock-record-children">
            {children.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(child.id);
                  }}
                >
                  {child.name} ({child.id})
                </button>{' '}
                {formatMass(child.grossMassMg, units)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>Contents</h4>
      {record === null ? (
        <p>Asking the simulation…</p>
      ) : record.lots.length === 0 ? (
        <p>No goods directly in it.</p>
      ) : (
        <table className="data-table" aria-label={`Lots in ${unit.id}`}>
          <thead>
            <tr>
              <th>Lot</th>
              <th>Product</th>
              <th>Grade</th>
              <th className="numeric">Quantity</th>
              <th className="numeric">Cost</th>
              <th>Disposition</th>
              <th>Came from</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {record.lots.map((lot) => (
              <tr key={lot.id} data-testid={`stock-record-lot-${lot.id}`}>
                <td>{lot.id}</td>
                <td>
                  {product(lot.productId)?.name ?? lot.productId}
                  {lot.serialCount > 0 ? (
                    <>
                      <br />
                      <span className="stock-serials">
                        Serials {lot.serials.slice(0, 12).join(', ')}
                        {lot.serialCount > 12 ? ` and ${lot.serialCount - 12} more` : ''}
                      </span>
                    </>
                  ) : null}
                </td>
                <td>{lot.grade}</td>
                <td className="numeric">{quantity(lot.productId, lot.quantityMicro)}</td>
                <td className="numeric">{formatCents(lot.costCents)}</td>
                <td>
                  {lot.disposition === 'scrap' ? 'Scrap' : 'Available'}
                  {lot.reservedMicro === '0'
                    ? ''
                    : `, ${quantity(lot.productId, lot.reservedMicro)} reserved`}
                </td>
                <td data-testid={`stock-provenance-${lot.id}`}>
                  {lot.lineage.map((step) => (
                    <div key={step.lotId}>
                      {step.lotId} {ORIGIN_LABEL[step.origin]} {step.createdOn}
                      {step.parents.length > 0 ? ` from ${step.parents.join(', ')}` : ''}
                      {step.receiptId
                        ? ` from ${step.supplier ?? 'a supplier'} (${step.receiptId}, ${step.invoiceId ?? ''})`
                        : ''}
                    </div>
                  ))}
                </td>
                <td>
                  {lot.disposition === 'available' ? (
                    <button
                      type="button"
                      disabled={host.pending}
                      onClick={() => {
                        setScrapping(scrapping === lot.id ? null : lot.id);
                        setMessage(null);
                      }}
                    >
                      Scrap…
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {scrapping && record ? (
        <form
          className="stock-scrap-form"
          aria-label={`Classify part of ${scrapping} as scrap`}
          onSubmit={(event) => {
            event.preventDefault();
            const lot = record.lots.find((candidate) => candidate.id === scrapping);
            if (lot) {
              void scrap(lot);
            }
          }}
        >
          <label>
            Quantity (
            {product(record.lots.find((lot) => lot.id === scrapping)?.productId ?? '')?.unit ?? ''}){' '}
            <input
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              size={10}
            />
          </label>{' '}
          <label>
            Reason{' '}
            <select
              value={reason}
              onChange={(event) => {
                const next = SCRAP_REASONS.find((candidate) => candidate === event.target.value);
                if (next) {
                  setReason(next);
                }
              }}
            >
              {SCRAP_REASONS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </label>{' '}
          <button type="submit" disabled={host.pending}>
            Classify as scrap
          </button>{' '}
          <span>
            Scrap stays where it is, its cost is written down to nothing, and it can no longer be
            used.
          </span>
        </form>
      ) : null}
      {message ? (
        <p role="alert" className="notice notice-warning" data-testid="stock-refusal">
          {message}
        </p>
      ) : null}
      <h4>History</h4>
      {record && record.history.length > 0 ? (
        <table
          className="data-table"
          aria-label={`History of ${unit.id}`}
          data-testid="stock-history"
        >
          <thead>
            <tr>
              <th>When</th>
              <th>Movement</th>
              <th>By</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {record.history.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.at}</td>
                <td>
                  {KIND_LABEL[entry.kind] ?? entry.kind}
                  {entry.reason ? ` (${entry.reason})` : ''} · {entry.id}
                </td>
                <td>{entry.handler}</td>
                <td>
                  {entry.units.map((placed) => (
                    <div key={`u${placed.loadUnitId}`}>
                      {placed.loadUnitId}: {placed.from} → {placed.to}
                    </div>
                  ))}
                  {entry.lines.map((line, index) => {
                    const amountText = quantity(line.productId, line.quantityMicro);
                    return (
                      <div key={`l${index}`}>
                        {amountText} of {line.lotId}
                        {line.from || line.to
                          ? `: ${line.from ?? 'outside'} → ${line.to ?? 'gone'}`
                          : ''}
                        {line.resultLotId ? ` (as ${line.resultLotId})` : ''}
                      </div>
                    );
                  })}
                  {entry.costCents === '0' ? '' : `Written off ${formatCents(entry.costCents)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No movements recorded.</p>
      )}
    </section>
  );
}
