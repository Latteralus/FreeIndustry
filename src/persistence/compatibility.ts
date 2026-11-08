import type { SaveHeader } from './world-repository';

/**
 * What a save's world needs from the build that loads it (ADR-0027). A
 * schema upgrade can change how a world is *stored*; it cannot change how it
 * *plays*. A world made under other simulation rules, another kernel format,
 * another RNG or other content would continue differently, so it is refused
 * with an explanation rather than loaded with a silently different future.
 * When a later step changes the rules, it must ship a domain conversion and
 * a fixture test for the old version, or keep refusing it here.
 */
export interface RuntimeCompatibility {
  readonly kernelFormat: number;
  readonly rulesId: string;
  readonly rulesVersion: number;
  readonly rngAlgorithm: string;
  readonly contentVersion: string | null;
}

export function compatibilityProblem(
  header: SaveHeader,
  runtime: RuntimeCompatibility,
): string | null {
  if (header.rulesId !== runtime.rulesId) {
    return `This save belongs to another simulation ("${header.rulesId}"), not FreeIndustry.`;
  }
  if (header.rulesVersion > runtime.rulesVersion) {
    return (
      `This save was made with FreeIndustry simulation rules version ${header.rulesVersion}, ` +
      `newer than this build's version ${runtime.rulesVersion}. Update FreeIndustry to load it.`
    );
  }
  if (header.rulesVersion < runtime.rulesVersion) {
    return (
      `This save was made with FreeIndustry simulation rules version ${header.rulesVersion}. ` +
      `This build runs version ${runtime.rulesVersion} and has no conversion for it, so the ` +
      'world cannot continue exactly as it would have.'
    );
  }
  if (header.kernelFormat !== runtime.kernelFormat) {
    return (
      `This save uses simulation kernel format ${header.kernelFormat}; this build uses ` +
      `format ${runtime.kernelFormat}.`
    );
  }
  if (header.rngAlgorithm !== runtime.rngAlgorithm) {
    return (
      `This save uses random-number algorithm ${header.rngAlgorithm}; this build uses ` +
      `${runtime.rngAlgorithm}.`
    );
  }
  if (header.contentVersion !== runtime.contentVersion) {
    return (
      `This save was built from content version ${header.contentVersion ?? 'none'}; this ` +
      `build has content version ${runtime.contentVersion ?? 'none'}.`
    );
  }
  return null;
}
