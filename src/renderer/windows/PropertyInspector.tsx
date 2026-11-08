import type { PropertyView, RealEstateView } from '../../shared/ipc/real-estate';
import { Inspector } from '../components/Inspector';
import type { Units } from '../app/desktop/profile-store';
import { formatCents } from '../app/money-input';
import {
  DOOR_LABEL,
  formatArea,
  formatDimensions,
  formatFloorLoad,
  formatLength,
  formatRentRate,
  PROPERTY_KIND_LABEL,
  ROLE_LABEL,
  USE_LABEL,
} from '../app/units';
import { FloorPlan } from '../scenes/FloorPlan';
import { STATUS_LABEL } from '../scenes/SitePlan';

/**
 * The record of one property (spec §3.1 step 4, §3.4): its true dimensions
 * and area (from its outline), access, services, permitted uses and terms,
 * who occupies it, and its floor drawn at the same scale for every property.
 * Everything is the worker's read model, formatted.
 */

/** Pixels per metre for the inspector's floor plan: the same for every property. */
const INSPECTOR_PIXELS_PER_METRE = 3;

export interface PropertyInspectorProps {
  readonly property: PropertyView;
  readonly realEstate: RealEstateView;
  readonly units: Units;
  /** Why the company cannot lease this property now, or null when it can. */
  readonly leaseRefusal: string | null;
  readonly onLease: (propertyId: string) => void;
}

/** "personnel door ×1, roller shutter ×2" */
function doorSummary(property: PropertyView): string {
  const counts = new Map<string, number>();
  for (const door of property.doors) {
    counts.set(DOOR_LABEL[door.kind], (counts.get(DOOR_LABEL[door.kind]) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ×${count}`).join(', ');
}

export function PropertyInspector({
  property,
  realEstate,
  units,
  leaseRefusal,
  onLease,
}: PropertyInspectorProps) {
  const district = realEstate.districts.find((item) => item.id === property.districtId);
  const occupant = property.occupant;
  const status =
    property.status === 'occupied' && occupant
      ? `Occupied by ${occupant.name} (${ROLE_LABEL[occupant.role].toLowerCase()}: ${occupant.trade})`
      : STATUS_LABEL[property.status];
  return (
    <div className="property-inspector" data-testid="property-inspector">
      <h3 className="window-heading">{property.address}</h3>
      <p>{property.description}</p>
      <Inspector
        label={`Property ${property.address}`}
        fields={[
          { label: 'Type', value: PROPERTY_KIND_LABEL[property.kind] },
          { label: 'District', value: district?.name ?? property.districtId },
          { label: 'Status', value: status, testId: 'property-status' },
          {
            label: 'Floor area',
            value: formatArea(property.areaMm2, units),
            testId: 'property-area',
          },
          {
            label: 'Dimensions',
            value: formatDimensions(property.widthMm, property.depthMm, units),
            testId: 'property-dimensions',
          },
          { label: 'Clear height', value: formatLength(property.clearHeightMm, units) },
          { label: 'Floor loading', value: formatFloorLoad(property.floorLoadKgPerM2, units) },
          {
            label: 'Power',
            value: `${property.powerKva} kVA, ${property.threePhase ? 'three-phase' : 'single-phase'}`,
          },
          {
            label: 'Services',
            value:
              [property.water ? 'water' : null, property.gas ? 'gas' : null]
                .filter((item) => item !== null)
                .join(', ') || 'none',
          },
          { label: 'Doors', value: doorSummary(property) },
          {
            label: 'Permitted uses',
            value: property.permittedUses.map((use) => USE_LABEL[use]).join(', '),
          },
          {
            label: 'Rent',
            value: `${formatCents(property.rentCentsPerMonth)} a month (${formatRentRate(property.rentCentsPerSqFtYear, property.rentCentsPerM2Year, units)})`,
            testId: 'property-rent',
          },
          {
            label: 'Deposit',
            value: `${formatCents(property.depositCents)} (${property.depositMonths} month${property.depositMonths === 1 ? '' : 's'} of rent)`,
          },
          {
            label: 'Due on signing',
            value: `${formatCents(property.upfrontCents)} (deposit and the first month's rent)`,
            testId: 'property-upfront',
          },
          {
            label: 'Lease terms',
            value: `${property.minTermMonths}–${property.maxTermMonths} months`,
          },
          { label: 'Landlord', value: property.landlord },
        ]}
      />
      <div className="button-row">
        <button
          type="button"
          disabled={leaseRefusal !== null}
          title={leaseRefusal ?? `Lease ${property.address}`}
          onClick={() => {
            onLease(property.id);
          }}
        >
          Lease…
        </button>
      </div>
      {leaseRefusal !== null && <p className="outcome">{leaseRefusal}</p>}
      <div className="property-floor" aria-label="Floor plan at a fixed scale">
        <FloorPlan
          property={property}
          pixelsPerMetre={INSPECTOR_PIXELS_PER_METRE}
          units={units}
          testId="property-floor-plan"
        />
      </div>
    </div>
  );
}

/** Why a property cannot be leased now (shown on the disabled button), or null. */
export function leaseRefusalFor(property: PropertyView, realEstate: RealEstateView): string | null {
  if (property.status === 'occupied') {
    return `${property.address} is occupied by ${property.occupant?.name ?? 'another business'}.`;
  }
  if (property.status === 'leased') {
    return 'You already lease this property.';
  }
  const active = realEstate.leases.find((lease) => lease.status === 'active');
  if (active) {
    return `You already lease ${active.address}. A second facility arrives with multi-site operations (Step 26).`;
  }
  return null;
}
