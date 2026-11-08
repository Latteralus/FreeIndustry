import type { PropertyView, RealEstateView } from '../../shared/ipc/real-estate';
import { DataTable, type Column } from '../components/DataTable';
import { Dropdown } from '../components/Dropdown';
import { Tabs, selectedTab } from '../components/Tabs';
import type { Units } from '../app/desktop/profile-store';
import { withFilter, withSort, withTab, type WindowViewProps } from '../app/desktop/window-catalog';
import type { WindowView } from '../app/desktop/window-model';
import { formatCents } from '../app/money-input';
import {
  formatArea,
  formatDistance,
  formatRentRate,
  PROPERTY_KIND_LABEL,
  ROLE_LABEL,
} from '../app/units';
import { SitePlan, STATUS_LABEL } from '../scenes/SitePlan';
import { leaseRefusalFor, PropertyInspector } from './PropertyInspector';

/**
 * City View (City → City View, toolbar City View; plan Step 07, spec §3.1
 * step 3): one city's industrial districts drawn to scale, with every
 * building selectable, its listings as a sortable table and its business
 * directory. The selected property's record and the Lease command sit
 * beside the plan. The city, district, tab and selected property are
 * remembered in the window's view (presentation only).
 */

const TABS = [
  { id: 'plan', label: 'Site plan' },
  { id: 'listings', label: 'Listings' },
  { id: 'directory', label: 'Directory' },
];

const PLAN_SCALES = ['1', '2', '4'] as const;

export interface CityWindowProps extends WindowViewProps {
  readonly realEstate: RealEstateView | null;
  readonly units: Units;
  readonly onLease: (propertyId: string) => void;
}

/** The city, district and property the view points at, falling back to the first that exists. */
function cityViewSelection(realEstate: RealEstateView, view: WindowView) {
  const filters = view.filters ?? {};
  const city =
    realEstate.cities.find((item) => item.id === filters['city']) ?? realEstate.cities[0] ?? null;
  const districts = realEstate.districts.filter((item) => item.cityId === city?.id);
  const district =
    districts.find((item) => item.id === filters['district']) ?? districts[0] ?? null;
  const property =
    realEstate.properties.find(
      (item) => item.id === filters['property'] && item.cityId === city?.id,
    ) ?? null;
  return { city, districts, district, property };
}

export function CityWindow({ realEstate, units, view, onViewChange, onLease }: CityWindowProps) {
  if (!realEstate) {
    return (
      <div className="window-content">
        <p>
          This world was created before cities and property existed, so it has no property market.
          Start a new company (File → New Company) to choose a city.
        </p>
      </div>
    );
  }
  const { city, districts, district, property } = cityViewSelection(realEstate, view);
  if (!city || !district) {
    return <div className="window-content">This world has no cities.</div>;
  }
  const tab = selectedTab(TABS, view.tab);
  const scale = PLAN_SCALES.find((item) => item === view.filters?.['scale']) ?? '2';
  const cityProperties = realEstate.properties.filter((item) => item.cityId === city.id);
  const select = (next: PropertyView) => {
    onViewChange({
      ...view,
      filters: { ...view.filters, city: city.id, district: next.districtId, property: next.id },
    });
  };
  const inspector = property ? (
    <PropertyInspector
      property={property}
      realEstate={realEstate}
      units={units}
      leaseRefusal={leaseRefusalFor(property, realEstate)}
      onLease={onLease}
    />
  ) : (
    <p className="property-inspector-empty">
      Select a building on the plan, or a listing, to see its record.
    </p>
  );

  const listingColumns: Column<PropertyView>[] = [
    {
      id: 'address',
      header: 'Address',
      sortValue: (row) => row.address,
      render: (row) => row.address,
    },
    {
      id: 'district',
      header: 'District',
      sortValue: (row) => row.districtId,
      render: (row) => districts.find((item) => item.id === row.districtId)?.name ?? '',
    },
    {
      id: 'kind',
      header: 'Type',
      sortValue: (row) => PROPERTY_KIND_LABEL[row.kind],
      render: (row) => PROPERTY_KIND_LABEL[row.kind],
    },
    {
      id: 'area',
      header: 'Floor area',
      numeric: true,
      sortValue: (row) => BigInt(row.areaMm2),
      render: (row) => formatArea(row.areaMm2, units),
    },
    {
      id: 'rent',
      header: 'Rent a month',
      numeric: true,
      sortValue: (row) => BigInt(row.rentCentsPerMonth),
      render: (row) => formatCents(row.rentCentsPerMonth),
    },
    {
      id: 'rate',
      header: 'Rent rate',
      numeric: true,
      sortValue: (row) => BigInt(row.rentCentsPerSqFtYear),
      render: (row) => formatRentRate(row.rentCentsPerSqFtYear, row.rentCentsPerM2Year, units),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => row.status,
      render: (row) =>
        row.status === 'occupied' && row.occupant ? row.occupant.name : STATUS_LABEL[row.status],
    },
    {
      id: 'inspect',
      header: '',
      render: (row) => (
        <button
          type="button"
          aria-label={`Inspect ${row.address}`}
          onClick={() => {
            onViewChange({
              ...view,
              tab: 'plan',
              filters: {
                ...view.filters,
                city: city.id,
                district: row.districtId,
                property: row.id,
              },
            });
          }}
        >
          Inspect
        </button>
      ),
    },
  ];

  const businesses = realEstate.businesses.filter((item) => item.cityId === city.id);
  type BusinessRow = (typeof businesses)[number];
  const businessColumns: Column<BusinessRow>[] = [
    { id: 'name', header: 'Business', sortValue: (row) => row.name, render: (row) => row.name },
    {
      id: 'role',
      header: 'Role',
      sortValue: (row) => row.role,
      render: (row) => ROLE_LABEL[row.role],
    },
    { id: 'trade', header: 'Trade', render: (row) => row.trade },
    {
      id: 'premises',
      header: 'Premises',
      render: (row) =>
        realEstate.properties.find((item) => item.id === row.propertyId)?.address ??
        'Elsewhere in the city',
    },
  ];

  return (
    <div className="window-content city-window">
      <div className="toolbar-row">
        <Dropdown
          label="City"
          value={city.id}
          options={realEstate.cities.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(next) => {
            onViewChange({
              ...view,
              filters: { ...view.filters, city: next, district: '', property: '' },
            });
          }}
        />
        {tab === 'plan' && (
          <>
            <Dropdown
              label="District"
              value={district.id}
              options={districts.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(next) => {
                onViewChange(withFilter(view, 'district', next));
              }}
            />
            <Dropdown
              label="Scale"
              value={scale}
              options={PLAN_SCALES.map((item) => ({ value: item, label: `${item} px per metre` }))}
              onChange={(next) => {
                onViewChange(withFilter(view, 'scale', next));
              }}
            />
          </>
        )}
      </div>
      <Tabs
        idPrefix="city"
        label="City view"
        tabs={TABS}
        selected={tab}
        onSelect={(next) => {
          onViewChange(withTab(view, next));
        }}
      >
        {tab === 'plan' && (
          <div className="city-plan">
            <div className="city-plan-map">
              <p className="city-plan-caption">
                {district.name}: {district.description} Highway junction{' '}
                {formatDistance(district.highwayAccessM, units)} by road;{' '}
                {district.railSiding ? 'rail siding' : 'no rail siding'}.
              </p>
              <SitePlan
                district={district}
                properties={cityProperties.filter((item) => item.districtId === district.id)}
                selectedId={property?.id ?? null}
                onSelect={(id) => {
                  const next = realEstate.properties.find((item) => item.id === id);
                  if (next) {
                    select(next);
                  }
                }}
                pixelsPerMetre={Number(scale)}
                units={units}
              />
              <p className="city-plan-legend">
                <span className="legend-swatch legend-vacant" /> Vacant{' '}
                <span className="legend-swatch legend-occupied" /> Occupied{' '}
                <span className="legend-swatch legend-leased" /> Leased by you
              </p>
            </div>
            <div className="city-plan-inspector">{inspector}</div>
          </div>
        )}
        {tab === 'listings' && (
          <DataTable
            label={`Properties in ${city.name}`}
            columns={listingColumns}
            rows={cityProperties}
            rowKey={(row) => row.id}
            rowTestId={(row) => `listing-${row.id}`}
            sort={view.sort ?? null}
            onSortChange={(sort) => {
              onViewChange(withSort(view, sort));
            }}
          />
        )}
        {tab === 'directory' && (
          <>
            <p>
              Businesses established in {city.name}: future competitors, suppliers and customers.
              Trading with them arrives with purchasing, sales and the marketplace (Steps 14–21).
            </p>
            <DataTable
              label={`Businesses in ${city.name}`}
              columns={businessColumns}
              rows={businesses}
              rowKey={(row) => row.id}
            />
          </>
        )}
      </Tabs>
    </div>
  );
}
