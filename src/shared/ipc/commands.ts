import { z } from 'zod';
import { positiveCentsString } from '../money';

/**
 * Command registry: every command the renderer may submit, its payload
 * schema and the permission it needs. Electron main checks permission and
 * payload before forwarding; the worker checks them again (ADR-0013).
 *
 * Game commands start in Step 05 (`company.*`, `finance.*`). Commands named
 * `diagnostics.*` are clearly labelled development aids (ADR-0016, ADR-0024,
 * ADR-0033), not game features. Clock control (pause, speed, advance) is not
 * a command: it changes pacing, never the world, and has its own request.
 * Money travels as canonical decimal strings of whole cents.
 */

/** A content identifier (city, district, property): lower-case words and digits joined by hyphens. */
const contentIdSchema = z
  .string()
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a content identifier');

/** The terms on which the company takes a lease (Step 07). */
const leaseTermsSchema = z.strictObject({
  propertyId: contentIdSchema,
  /** Lease length in whole months, within the listing's minimum and maximum. */
  termMonths: z.int().min(1).max(120),
  /** Let the bank pay each month's rent on its due date. */
  standingOrder: z.boolean(),
});

/** Longest delay before a diagnostic test obligation's first bill: one year. */
export const MAX_TEST_OBLIGATION_START_DAYS = 366;

/** Longest delay a diagnostic probe may be scheduled ahead: seven simulated days. */
export const MAX_PROBE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * - `renderer`: the app's own renderer may submit it.
 * - `fault-injection`: only in unpackaged builds started with
 *   `FREEINDUSTRY_FAULT_INJECTION=1` (automated failure tests).
 */
type CommandPermission = 'renderer' | 'fault-injection';

interface CommandDefinition {
  readonly permission: CommandPermission;
  readonly payload: z.ZodType;
}

const INJECTABLE_FAULTS = [
  /** The command handler throws part-way through; proves atomic rollback. */
  'handler-exception',
  /** An uncaught exception escapes on the worker's next tick; the thread dies. */
  'uncaught-exception',
  /** The worker thread exits immediately, before answering. */
  'thread-exit',
] as const;

export type InjectableFault = (typeof INJECTABLE_FAULTS)[number];

export const COMMANDS = {
  /**
   * Found the player's company: its legal name, president, and the capital
   * the owner pays into the company's bank account (spec §3.1 step 5).
   * With `premises`, the company also signs a lease in the same command, so
   * founding and leasing succeed or fail together (Step 07, ADR-0038).
   */
  'company.found': {
    permission: 'renderer',
    payload: z.strictObject({
      legalName: z.string().min(1).max(60),
      presidentName: z.string().min(1).max(60),
      startingCapitalCents: positiveCentsString,
      premises: leaseTermsSchema.optional(),
    }),
  },
  /**
   * Lease a vacant property: pays the deposit and the first month's rent now
   * and commits the company to monthly rent for the term (Step 07, ADR-0038).
   */
  'realEstate.lease': {
    permission: 'renderer',
    payload: leaseTermsSchema,
  },
  /** Pay (part of) a bill the company owes, from its bank account. */
  'finance.payInvoice': {
    permission: 'renderer',
    payload: z.strictObject({
      invoiceId: z.string().regex(/^invoice:[1-9][0-9]{0,15}$/),
      amountCents: positiveCentsString,
    }),
  },
  /**
   * Development-only: commit the company to a rent or deposit schedule with a
   * fictional "Diagnostic landlord", so the obligation, invoice, standing order
   * and overdue rules can be exercised directly in tests (ADR-0032, ADR-0038).
   */
  'diagnostics.addTestObligation': {
    permission: 'renderer',
    payload: z.strictObject({
      purpose: z.enum(['rent', 'security-deposit']),
      amountCents: positiveCentsString,
      cadence: z.enum(['once', 'monthly']),
      occurrences: z.int().min(1).max(120),
      firstBillInDays: z.int().min(0).max(MAX_TEST_OBLIGATION_START_DAYS),
      paymentTermsDays: z.int().min(0).max(90),
      standingOrder: z.boolean(),
    }),
  },
  /** Development-only probe that records a label, proving the round trip changes worker state. */
  'diagnostics.recordProbe': {
    permission: 'renderer',
    payload: z.strictObject({ label: z.string().min(1).max(80) }),
  },
  /**
   * Development-only: schedules a simulation event `delayMs` simulated
   * milliseconds ahead. When it fires it draws a token from the seeded
   * random stream, proving command → event queue → RNG through the real app.
   */
  'diagnostics.scheduleProbe': {
    permission: 'renderer',
    payload: z.strictObject({
      label: z.string().min(1).max(80),
      delayMs: z.int().min(1).max(MAX_PROBE_DELAY_MS),
    }),
  },
  'diagnostics.injectFault': {
    permission: 'fault-injection',
    payload: z.strictObject({ fault: z.enum(INJECTABLE_FAULTS) }),
  },
} as const satisfies Record<string, CommandDefinition>;

export type CommandType = keyof typeof COMMANDS;

export function isCommandType(type: string): type is CommandType {
  return Object.hasOwn(COMMANDS, type);
}
