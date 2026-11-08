/**
 * A business-rule refusal. Command handlers return one instead of a new
 * state when a valid, current command is not allowed (for example: not enough
 * money, no room, nobody qualified). It reaches the player as
 * `COMMAND_REJECTED` with the reason; the world is left unchanged and the
 * command is not journaled.
 */
export class Rejection {
  readonly reason: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    reason: string,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    this.reason = reason;
    this.details = details;
  }
}

export function reject(
  reason: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): Rejection {
  return new Rejection(reason, details);
}
