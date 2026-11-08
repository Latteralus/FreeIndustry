import type { FreeIndustryBridge } from '../shared/bridge';

declare global {
  interface Window {
    readonly freeIndustry?: FreeIndustryBridge;
  }
}

export {};
