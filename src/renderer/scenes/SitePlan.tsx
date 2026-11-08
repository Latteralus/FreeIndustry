import type { KeyboardEvent } from 'react';
import type { DistrictView, PropertyView } from '../../shared/ipc/real-estate';
import type { Units } from '../app/desktop/profile-store';
import { formatCents } from '../app/money-input';
import { formatArea, PROPERTY_KIND_LABEL, scaleBarLength } from '../app/units';

/**
 * An industrial district drawn to scale (plan Step 07, spec §3.1, §3.3 city
 * view): its streets and every building, each from its real floor outline
 * placed at its real position, at a fixed number of pixels per metre. A
 * garage is therefore drawn tiny beside a factory (design law D05); nothing
 * is resized to fit. Buildings are selectable with the mouse or the keyboard
 * and carry a factual tooltip. Colours show the actual occupancy, always with
 * a text label as well.
 */

export interface SitePlanProps {
  readonly district: DistrictView;
  readonly properties: readonly PropertyView[];
  readonly selectedId: string | null;
  readonly onSelect: (propertyId: string) => void;
  readonly pixelsPerMetre: number;
  readonly units: Units;
}

export const STATUS_LABEL = {
  vacant: 'Vacant',
  occupied: 'Occupied',
  leased: 'Leased by you',
} as const;

function propertySummary(property: PropertyView, units: Units): string {
  const status =
    property.status === 'occupied' && property.occupant
      ? `Occupied by ${property.occupant.name}`
      : STATUS_LABEL[property.status];
  return (
    `${property.address}: ${PROPERTY_KIND_LABEL[property.kind]}, ` +
    `${formatArea(property.areaMm2, units)}, ${formatCents(property.rentCentsPerMonth)} a month. ${status}.`
  );
}

export function SitePlan({
  district,
  properties,
  selectedId,
  onSelect,
  pixelsPerMetre,
  units,
}: SitePlanProps) {
  const scale = pixelsPerMetre;
  const width = district.siteWidthM * scale;
  const height = district.siteDepthM * scale;
  const bar = scaleBarLength(scale, units);
  const onKeyDown = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
    }
  };
  return (
    <svg
      className="site-plan"
      width={width}
      height={height + 24}
      viewBox={`0 0 ${width} ${height + 24}`}
      role="group"
      aria-label={`Site plan of ${district.name}, drawn to scale`}
      data-testid="site-plan"
    >
      <rect className="site-ground" x={0} y={0} width={width} height={height} />
      {district.streets.map((street) => {
        const horizontal = street.from.y === street.to.y;
        const half = (street.widthM * scale) / 2;
        const x = Math.min(street.from.x, street.to.x) * scale - (horizontal ? 0 : half);
        const y = Math.min(street.from.y, street.to.y) * scale - (horizontal ? half : 0);
        const length = Math.abs(
          horizontal ? street.to.x - street.from.x : street.to.y - street.from.y,
        );
        return (
          <g key={street.name} className="site-street">
            <rect
              x={x}
              y={y}
              width={horizontal ? length * scale : street.widthM * scale}
              height={horizontal ? street.widthM * scale : length * scale}
            />
            <text
              className="site-street-name"
              x={horizontal ? x + 8 : x + half}
              y={horizontal ? y + half + 4 : y + 16}
              transform={horizontal ? undefined : `rotate(90 ${x + half} ${y + 16})`}
            >
              {street.name}
            </text>
          </g>
        );
      })}
      {properties.map((property) => {
        const points = property.floor
          .map((corner) => {
            const px = (property.site.x + corner.x / 1000) * scale;
            const py = (property.site.y + corner.y / 1000) * scale;
            return `${px},${py}`;
          })
          .join(' ');
        const selected = property.id === selectedId;
        const summary = propertySummary(property, units);
        return (
          <g
            key={property.id}
            role="button"
            tabIndex={0}
            aria-label={summary}
            aria-pressed={selected}
            data-testid={`building-${property.id}`}
            data-status={property.status}
            className={`site-building site-building-${property.status}${selected ? ' site-building-selected' : ''}`}
            onClick={() => {
              onSelect(property.id);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, property.id);
            }}
          >
            <title>{summary}</title>
            <polygon points={points} />
          </g>
        );
      })}
      <g className="site-scale" transform={`translate(8 ${height + 6})`}>
        <rect x={0} y={4} width={bar.pixels} height={4} />
        <text x={bar.pixels + 6} y={10}>
          {bar.label}
        </text>
      </g>
    </svg>
  );
}
