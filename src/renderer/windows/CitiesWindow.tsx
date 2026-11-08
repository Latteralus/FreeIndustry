import type { CityView, RealEstateView } from '../../shared/ipc/real-estate';
import { DataTable, type Column } from '../components/DataTable';
import { Inspector } from '../components/Inspector';
import type { Units } from '../app/desktop/profile-store';
import { withFilter, withSort, type WindowViewProps } from '../app/desktop/window-catalog';
import { formatCents } from '../app/money-input';
import { formatDistance, formatRentRate, ROLE_LABEL } from '../app/units';

/**
 * City Selection (City → Cities, and the first step of New Company; plan
 * Step 07, spec §3.1 step 2): the cities on a schematic regional map and in
 * a comparison table — population, labour force and prevailing wages, rents
 * and vacancies, transport, and the businesses already established there.
 * Every figure is the worker's; averages are computed from the listings.
 */

const LABOR_LABEL = {
  production: 'Production',
  warehouse: 'Warehouse',
  office: 'Office',
  technical: 'Technical',
} as const;

export interface CitiesWindowProps extends WindowViewProps {
  readonly realEstate: RealEstateView | null;
  readonly units: Units;
  readonly onViewCity: (cityId: string) => void;
}

function wage(city: CityView, laborClass: keyof typeof LABOR_LABEL): string {
  const rate = city.wageRates.find((item) => item.laborClass === laborClass);
  return rate ? `${formatCents(rate.centsPerHour)}/h` : '—';
}

const percent = (permille: number) => `${(permille / 10).toFixed(1)}%`;

export function CitiesWindow({
  realEstate,
  units,
  view,
  onViewChange,
  onViewCity,
}: CitiesWindowProps) {
  if (!realEstate) {
    return (
      <div className="window-content">
        <p>
          This world was created before cities and property existed. Start a new company (File → New
          Company) to choose a city.
        </p>
      </div>
    );
  }
  const selected =
    realEstate.cities.find((city) => city.id === view.filters?.['city']) ??
    realEstate.cities[0] ??
    null;
  const choose = (id: string) => {
    onViewChange(withFilter(view, 'city', id));
  };
  const rent = (city: CityView) =>
    city.averageRentCentsPerSqFtYear === null || city.averageRentCentsPerM2Year === null
      ? '—'
      : formatRentRate(city.averageRentCentsPerSqFtYear, city.averageRentCentsPerM2Year, units);

  const columns: Column<CityView>[] = [
    {
      id: 'name',
      header: 'City',
      sortValue: (row) => row.name,
      render: (row) => (
        <button
          type="button"
          className="link-button"
          aria-pressed={row.id === selected?.id}
          onClick={() => {
            choose(row.id);
          }}
        >
          {row.name}, {row.region}
        </button>
      ),
    },
    {
      id: 'population',
      header: 'Population',
      numeric: true,
      sortValue: (row) => row.population,
      render: (row) => row.population.toLocaleString('en-US'),
    },
    {
      id: 'unemployment',
      header: 'Unemployed',
      numeric: true,
      sortValue: (row) => row.unemploymentPermille,
      render: (row) => percent(row.unemploymentPermille),
    },
    {
      id: 'production',
      header: 'Production wage',
      numeric: true,
      sortValue: (row) =>
        BigInt(row.wageRates.find((item) => item.laborClass === 'production')?.centsPerHour ?? 0),
      render: (row) => wage(row, 'production'),
    },
    {
      id: 'rent',
      header: 'Average rent',
      numeric: true,
      sortValue: (row) => BigInt(row.averageRentCentsPerSqFtYear ?? 0),
      render: rent,
    },
    {
      id: 'vacancies',
      header: 'Vacant',
      numeric: true,
      sortValue: (row) => row.vacancies,
      render: (row) => `${row.vacancies} of ${row.listings}`,
    },
    {
      id: 'businesses',
      header: 'Makers / suppliers / buyers',
      numeric: true,
      render: (row) => `${row.manufacturers} / ${row.suppliers} / ${row.buyers}`,
    },
  ];

  const districts = realEstate.districts.filter((district) => district.cityId === selected?.id);
  const businesses = realEstate.businesses.filter((business) => business.cityId === selected?.id);

  return (
    <div className="window-content cities-window">
      <div className="cities-top">
        <svg
          className="region-map"
          width={240}
          height={240}
          viewBox="0 0 1000 1000"
          role="group"
          aria-label="Regional map (schematic, not to scale)"
        >
          <rect className="region-map-land" x={0} y={0} width={1000} height={1000} />
          {realEstate.cities.map((city) => (
            <g
              key={city.id}
              role="button"
              tabIndex={0}
              aria-label={`${city.name}, ${city.region}`}
              aria-pressed={city.id === selected?.id}
              className={`region-city${city.id === selected?.id ? ' region-city-selected' : ''}`}
              onClick={() => {
                choose(city.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  choose(city.id);
                }
              }}
            >
              <title>{`${city.name}, ${city.region}: population ${city.population.toLocaleString('en-US')}`}</title>
              <rect x={city.map.x - 18} y={city.map.y - 18} width={36} height={36} />
              <text x={city.map.x + 28} y={city.map.y + 12}>
                {city.name}
              </text>
            </g>
          ))}
        </svg>
        <DataTable
          label="Cities"
          columns={columns}
          rows={realEstate.cities}
          rowKey={(row) => row.id}
          rowTestId={(row) => `city-${row.id}`}
          sort={view.sort ?? null}
          onSortChange={(sort) => {
            onViewChange(withSort(view, sort));
          }}
        />
      </div>
      {selected && (
        <div className="cities-detail" data-testid="city-detail">
          <h3 className="window-heading">
            {selected.name}, {selected.region}
          </h3>
          <p>{selected.description}</p>
          <Inspector
            label={`City ${selected.name}`}
            fields={[
              { label: 'Population', value: selected.population.toLocaleString('en-US') },
              {
                label: 'Labour force',
                value: `${selected.workforce.toLocaleString('en-US')}, ${percent(selected.unemploymentPermille)} unemployed`,
              },
              {
                label: 'Prevailing wages',
                value: (Object.keys(LABOR_LABEL) as (keyof typeof LABOR_LABEL)[])
                  .map((laborClass) => `${LABOR_LABEL[laborClass]} ${wage(selected, laborClass)}`)
                  .join(', '),
              },
              { label: 'Average asking rent', value: rent(selected) },
              {
                label: 'Properties',
                value: `${selected.listings} listed, ${selected.vacancies} vacant`,
              },
              {
                label: 'Districts',
                value: districts
                  .map(
                    (district) =>
                      `${district.name} (highway ${formatDistance(district.highwayAccessM, units)}${district.railSiding ? ', rail siding' : ''})`,
                  )
                  .join('; '),
              },
              {
                label: 'Businesses',
                value:
                  businesses
                    .map(
                      (business) =>
                        `${business.name} (${ROLE_LABEL[business.role].toLowerCase()}: ${business.trade})`,
                    )
                    .join('; ') || 'None',
              },
            ]}
          />
          <p className="outcome">
            Wages are this city&apos;s survey rates; the labour market, prices and trade begin with
            personnel and the marketplace (Steps 11–21).
          </p>
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                onViewCity(selected.id);
              }}
            >
              View {selected.name}…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
