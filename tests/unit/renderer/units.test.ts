import { memoryProfileStore, readUnits } from '../../../src/renderer/app/desktop/profile-store';
import {
  formatArea,
  formatDimensions,
  formatDistance,
  formatFloorLoad,
  formatLength,
  formatRentRate,
  scaleBarLength,
} from '../../../src/renderer/app/units';

describe('display units (presentation only)', () => {
  it('formats the worker’s millimetres in US customary units by default, or metric', () => {
    expect(formatArea('96000000', 'us')).toBe('1,033 sq ft');
    expect(formatArea('96000000', 'metric')).toBe('96.0 m²');
    expect(formatLength(8000, 'us')).toBe('26 ft 3 in');
    expect(formatLength(3048, 'us')).toBe('10 ft');
    expect(formatLength(8000, 'metric')).toBe('8.00 m');
    expect(formatDimensions(3000, 6000, 'us')).toBe('9 ft 10 in × 19 ft 8 in');
    expect(formatDistance(600, 'metric')).toBe('600 m');
    expect(formatDistance(3200, 'metric')).toBe('3.2 km');
    expect(formatDistance(3200, 'us')).toBe('2.0 mi');
    expect(formatFloorLoad(500, 'metric')).toBe('500 kg/m²');
    expect(formatFloorLoad(500, 'us')).toBe('102 lb/sq ft');
    expect(formatRentRate('604', '6500', 'us')).toBe('$6.04 per sq ft a year');
    expect(formatRentRate('604', '6500', 'metric')).toBe('$65.00 per m² a year');
  });

  it('chooses a round scale-bar length of at least 80 pixels', () => {
    expect(scaleBarLength(10, 'metric')).toEqual({ pixels: 100, label: '10 m' });
    expect(scaleBarLength(10, 'us')).toEqual({ pixels: 152, label: '50 ft' });
    expect(scaleBarLength(2, 'metric')).toEqual({ pixels: 100, label: '50 m' });
  });

  it('remembers the unit system per profile, defaulting to US customary', () => {
    expect(readUnits(memoryProfileStore())).toBe('us');
    expect(readUnits(memoryProfileStore({ units: 'metric' }))).toBe('metric');
    expect(readUnits(memoryProfileStore({ units: 'imperial-ish' }))).toBe('us');
  });
});
