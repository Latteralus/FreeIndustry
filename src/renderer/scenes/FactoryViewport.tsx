import { useState } from 'react';
import type { PropertyView } from '../../shared/ipc/real-estate';
import type { Units } from '../app/desktop/profile-store';
import { formatArea, PROPERTY_KIND_LABEL } from '../app/units';
import { FloorPlan } from './FloorPlan';

/**
 * The factory viewport: the workspace background that management windows
 * open over (spec §3.2). It is mounted once and stays behind every window.
 *
 * With premises leased it shows the facility's interior, top-down and to
 * scale, exactly as empty as it is: no equipment, staff or stock exist until
 * the player buys, hires and places them (Steps 08–17). The zoom steps
 * change how many pixels stand for a metre, the same for every building, so
 * a garage is always drawn small beside a factory (design law D05). Without
 * premises it says so plainly instead of showing a picture of a factory that
 * does not exist. The PixiJS renderer (Step 09) will draw here.
 */

const VIEWPORT_ZOOMS = [2.5, 5, 10, 20, 40] as const;
const DEFAULT_ZOOM_INDEX = 2;

export interface FactoryViewportProps {
  readonly companyName: string | null;
  /** The property the company leases, or null. */
  readonly premises: PropertyView | null;
  readonly units: Units;
}

export function FactoryViewport({ companyName, premises, units }: FactoryViewportProps) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM_INDEX);
  const pixelsPerMetre = VIEWPORT_ZOOMS[zoom] ?? 10;
  return (
    <div
      className="factory-viewport"
      role="region"
      aria-label="Factory floor"
      data-testid="factory-viewport"
    >
      {premises ? (
        <div className="factory-viewport-floor">
          <div className="factory-viewport-caption" data-testid="facility-caption">
            <strong>{premises.address}</strong> · {PROPERTY_KIND_LABEL[premises.kind]},{' '}
            {formatArea(premises.areaMm2, units)} · Empty: no equipment, staff or stock
            <span className="factory-viewport-zoom" role="group" aria-label="Zoom">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={zoom === 0}
                onClick={() => {
                  setZoom((current) => Math.max(0, current - 1));
                }}
              >
                −
              </button>
              <span data-testid="viewport-scale">{pixelsPerMetre} px/m</span>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={zoom === VIEWPORT_ZOOMS.length - 1}
                onClick={() => {
                  setZoom((current) => Math.min(VIEWPORT_ZOOMS.length - 1, current + 1));
                }}
              >
                +
              </button>
            </span>
          </div>
          <FloorPlan
            property={premises}
            pixelsPerMetre={pixelsPerMetre}
            units={units}
            testId="facility-floor-plan"
          />
        </div>
      ) : (
        <div className="factory-viewport-empty">
          <p className="factory-viewport-title">No facility</p>
          <p>
            {companyName === null
              ? 'No company has been founded.'
              : `${companyName} has no premises yet.`}{' '}
            Choose a property from City → City View and lease it; its floor is then drawn here to
            its real dimensions.
          </p>
        </div>
      )}
    </div>
  );
}
