import { useState } from 'react';
import type { WorldSnapshot } from '../../shared/ipc/contract';
import { parseDollarsToCents } from '../app/money-input';
import { parseQuantity } from '../app/units';
import type { SimulationHostView } from '../app/useSimulationHost';

/**
 * Stock diagnostics (development only; plan Step 10, ADR-0055): a fictional
 * "Diagnostic supplier" delivers paid-for goods onto the landings inside the
 * company's goods doors, so stock can be seen on the floor, inspected and
 * classified before purchasing and receiving exist (Step 14). Every capacity
 * and floor rule applies, and the cost goes through the books.
 */
export function TestDeliveryTab({
  world,
  host,
}: {
  readonly world: WorldSnapshot | null;
  readonly host: Pick<SimulationHostView, 'submit' | 'pending'>;
}) {
  const stock = world?.stock ?? null;
  const [productId, setProductId] = useState(stock?.products[0]?.id ?? '');
  const [containerTypeId, setContainerTypeId] = useState('carton-24x16x16');
  const [containers, setContainers] = useState('4');
  const [quantityText, setQuantityText] = useState('200');
  const [palletTypeId, setPalletTypeId] = useState('gma-pallet');
  const [perPallet, setPerPallet] = useState('4');
  const [cost, setCost] = useState('250.00');
  const [message, setMessage] = useState<string | null>(null);

  if (!world?.company || !stock) {
    return (
      <p>
        Found a company in a world with stock records (a new company since plan Step 10) to make a
        test delivery.
      </p>
    );
  }
  const product = stock.products.find((candidate) => candidate.id === productId);
  const pallets = stock.containerTypes.filter((type) => type.kind === 'pallet');
  const quantityMicro = parseQuantity(quantityText);
  const totalCostCents = parseDollarsToCents(cost);
  const count = Number(containers);
  const onPallet = palletTypeId !== '';
  const perPalletCount = Number(perPallet);
  const valid =
    product !== undefined &&
    quantityMicro !== null &&
    totalCostCents !== null &&
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 100 &&
    (!onPallet ||
      (Number.isInteger(perPalletCount) && perPalletCount >= 1 && perPalletCount <= 100));

  return (
    <section aria-labelledby="test-delivery-heading">
      <h3 id="test-delivery-heading">Stock diagnostics: test delivery (development only)</h3>
      <p>
        A fictional &quot;Diagnostic supplier&quot; unloads paid-for goods onto the receiving area
        inside a goods door (roller shutter or loading dock) of the company&rsquo;s premises. It
        stands in for purchasing and receiving until plan Step 14.
      </p>
      <form
        className="form-grid"
        aria-label="Test delivery"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) {
            setMessage('Complete the delivery: a product, a quantity, a count and a cost.');
            return;
          }
          void host
            .submit('diagnostics.deliverTestStock', {
              productId,
              grade: null,
              containerTypeId,
              containers: count,
              quantityPerContainerMicro: quantityMicro,
              palletTypeId: onPallet ? palletTypeId : null,
              containersPerPallet: onPallet ? perPalletCount : null,
              totalCostCents,
            })
            .then((outcome) => {
              setMessage(outcome?.kind === 'rejected' ? outcome.error.message : null);
            });
        }}
      >
        <label htmlFor="delivery-product">Product</label>
        <select
          id="delivery-product"
          value={productId}
          onChange={(event) => {
            setProductId(event.target.value);
          }}
        >
          {stock.products.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        <label htmlFor="delivery-container">Container</label>
        <select
          id="delivery-container"
          value={containerTypeId}
          onChange={(event) => {
            setContainerTypeId(event.target.value);
          }}
        >
          {stock.containerTypes
            .filter((type) => type.kind !== 'cart' && type.kind !== 'machine-buffer')
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
        </select>
        <label htmlFor="delivery-containers">Containers</label>
        <input
          id="delivery-containers"
          inputMode="numeric"
          size={4}
          value={containers}
          onChange={(event) => {
            setContainers(event.target.value);
          }}
        />
        <label htmlFor="delivery-quantity">Each holds ({product?.unit ?? 'units'})</label>
        <input
          id="delivery-quantity"
          inputMode="decimal"
          size={10}
          value={quantityText}
          onChange={(event) => {
            setQuantityText(event.target.value);
          }}
        />
        <label htmlFor="delivery-pallet">Loaded on</label>
        <select
          id="delivery-pallet"
          value={palletTypeId}
          onChange={(event) => {
            setPalletTypeId(event.target.value);
          }}
        >
          <option value="">Nothing (each stands on the floor)</option>
          {pallets.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <label htmlFor="delivery-per-pallet">Containers per pallet</label>
        <input
          id="delivery-per-pallet"
          inputMode="numeric"
          size={4}
          disabled={!onPallet}
          value={perPallet}
          onChange={(event) => {
            setPerPallet(event.target.value);
          }}
        />
        <label htmlFor="delivery-cost">Total cost ($)</label>
        <input
          id="delivery-cost"
          inputMode="decimal"
          value={cost}
          onChange={(event) => {
            setCost(event.target.value);
          }}
        />
        <span />
        <button type="submit" disabled={host.pending}>
          Deliver
        </button>
      </form>
      {message ? (
        <p role="alert" className="notice notice-warning" data-testid="delivery-refusal">
          {message}
        </p>
      ) : null}
    </section>
  );
}
