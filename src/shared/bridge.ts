/**
 * Shape of the API the preload script exposes on `window.freeIndustry`.
 * Step 01 exposes read-only runtime information only; the typed, validated
 * simulation command API is introduced in Step 02.
 */
export interface FreeIndustryBridge {
  readonly runtime: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}
