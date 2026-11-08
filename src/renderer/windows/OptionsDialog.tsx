import { Dialog } from '../components/Dialog';
import { Dropdown } from '../components/Dropdown';
import { UI_SCALES, type UiScale, type Units } from '../app/desktop/profile-store';

/**
 * Options (Main Menu, File → Options; plan Step 07): the profile's display
 * preferences. They change presentation only, take effect at once and are
 * kept for this user profile (ADR-0035, ADR-0041); they are not world state.
 * The rest of spec §3.1's options (sound, autosave, data location,
 * shortcuts) are Step 31.
 */

export interface OptionsDialogProps {
  readonly uiScale: UiScale;
  readonly units: Units;
  readonly onUiScale: (scale: UiScale) => void;
  readonly onUnits: (units: Units) => void;
  readonly onClose: () => void;
}

export function OptionsDialog({ uiScale, units, onUiScale, onUnits, onClose }: OptionsDialogProps) {
  return (
    <Dialog title="Options" onClose={onClose} testId="options-dialog">
      <div className="form-grid">
        <Dropdown
          label="UI scale"
          value={String(uiScale)}
          options={UI_SCALES.map((scale) => ({ value: String(scale), label: `${scale}%` }))}
          onChange={(value) => {
            const scale = UI_SCALES.find((item) => String(item) === value);
            if (scale) {
              onUiScale(scale);
            }
          }}
        />
        <Dropdown
          label="Units"
          value={units}
          options={[
            { value: 'us', label: 'US customary (feet, square feet)' },
            { value: 'metric', label: 'Metric (metres, square metres)' },
          ]}
          onChange={onUnits}
        />
      </div>
      <p>
        These preferences belong to this user profile, not to a saved game. Sound, autosave and
        keyboard options arrive with Step 31.
      </p>
      <div className="button-row">
        <button type="button" onClick={onClose}>
          OK
        </button>
      </div>
    </Dialog>
  );
}
