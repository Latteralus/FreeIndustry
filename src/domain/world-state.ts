import type { Company } from './company';
import type { DiagnosticsState } from './diagnostics';
import type { RealEstate } from './real-estate';

/**
 * The FreeIndustry domain state: everything the business rules own, one slice
 * per system (and one table group per slice in `src/persistence`, which
 * stores each relationally, ADR-0026).
 */
export interface FreeIndustryState {
  readonly diagnostics: DiagnosticsState;
  /** The player's company; null until it is founded (Step 05, ADR-0031). */
  readonly company: Company | null;
  /**
   * Cities, districts, properties, established businesses and leases; null in
   * worlds created before Step 07, which have no real estate (ADR-0037).
   */
  readonly realEstate: RealEstate | null;
}
