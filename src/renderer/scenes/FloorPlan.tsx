import type { PropertyView } from '../../shared/ipc/real-estate';
import type { Units } from '../app/desktop/profile-store';
import { DOOR_LABEL, formatLength, scaleBarLength } from '../app/units';

/**
 * A property's interior floor, top-down and to scale: the outline from its
 * real corner coordinates, its doors at their real positions in the walls,
 * the overall dimensions and a scale bar. Drawn at a fixed number of pixels
 * per metre, never fitted to the space available (design law D05), so a
 * garage is small on screen and a factory large. Presentation only. The
 * company's own premises are drawn by `FacilityPlan` (Step 08); this drawing
 * serves the property inspector and worlds made before Step 08.
 */

export interface FloorPlanProps {
  readonly property: PropertyView;
  readonly pixelsPerMetre: number;
  readonly units: Units;
  readonly testId?: string;
}

const MARGIN = 40;
const WALL = 3;

interface DoorMark {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly kind: PropertyView['doors'][number]['kind'];
  readonly label: string;
}

function doorMarks(property: PropertyView, scale: number, units: Units): DoorMark[] {
  return property.doors.flatMap((door) => {
    const from = property.floor[door.edge];
    const to = property.floor[(door.edge + 1) % property.floor.length];
    if (!from || !to) {
      return [];
    }
    const dx = Math.sign(to.x - from.x);
    const dy = Math.sign(to.y - from.y);
    const start = { x: from.x + dx * door.offsetMm, y: from.y + dy * door.offsetMm };
    const end = { x: start.x + dx * door.widthMm, y: start.y + dy * door.widthMm };
    const px = (mm: number) => MARGIN + (mm / 1000) * scale;
    return [
      {
        x1: px(start.x),
        y1: px(start.y),
        x2: px(end.x),
        y2: px(end.y),
        kind: door.kind,
        label: `${DOOR_LABEL[door.kind]}, ${formatLength(door.widthMm, units)} wide × ${formatLength(door.heightMm, units)} high`,
      },
    ];
  });
}

export function FloorPlan({ property, pixelsPerMetre, units, testId }: FloorPlanProps) {
  const scale = pixelsPerMetre;
  const px = (mm: number) => MARGIN + (mm / 1000) * scale;
  const width = (property.widthMm / 1000) * scale + MARGIN * 2;
  const height = (property.depthMm / 1000) * scale + MARGIN * 2;
  const points = property.floor.map((corner) => `${px(corner.x)},${px(corner.y)}`).join(' ');
  const bar = scaleBarLength(scale, units);
  return (
    <svg
      className="floor-plan"
      width={Math.max(width, bar.pixels + 2 * MARGIN + 60)}
      height={height + 20}
      role="img"
      aria-label={`Floor plan of ${property.address}, ${formatLength(property.widthMm, units)} by ${formatLength(property.depthMm, units)}, drawn to scale`}
      data-testid={testId}
      data-pixels-per-metre={scale}
    >
      <polygon className="floor-plan-floor" points={points} strokeWidth={WALL} />
      {doorMarks(property, scale, units).map((door, index) => (
        <line
          key={index}
          className={`floor-plan-door floor-plan-door-${door.kind}`}
          x1={door.x1}
          y1={door.y1}
          x2={door.x2}
          y2={door.y2}
        >
          <title>{door.label}</title>
        </line>
      ))}
      <text className="floor-plan-dimension" x={px(property.widthMm / 2)} y={MARGIN - 12}>
        {formatLength(property.widthMm, units)}
      </text>
      <text
        className="floor-plan-dimension"
        x={MARGIN - 12}
        y={px(property.depthMm / 2)}
        transform={`rotate(-90 ${MARGIN - 12} ${px(property.depthMm / 2)})`}
      >
        {formatLength(property.depthMm, units)}
      </text>
      <g className="site-scale" transform={`translate(${MARGIN} ${height - 6})`}>
        <rect x={0} y={4} width={bar.pixels} height={4} />
        <text x={bar.pixels + 6} y={10}>
          {bar.label}
        </text>
      </g>
    </svg>
  );
}
