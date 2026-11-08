import { z } from 'zod';

/** Small schemas shared by the IPC contract modules. */

/** A `bigint` simulation time carried as a canonical decimal string (bigint-codec). */
export const simTimeString = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .max(20);

export const calendarSchema = z.strictObject({
  year: z.int(),
  month: z.int().min(1).max(12),
  day: z.int().min(1).max(31),
  /** ISO weekday, 1 = Monday. */
  weekday: z.int().min(1).max(7),
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59),
  second: z.int().min(0).max(59),
});
