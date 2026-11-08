import { config } from 'zod';

/**
 * Zod's fast path compiles validators with `new Function`, which the
 * renderer's CSP forbids; Zod would probe for it (raising a CSP violation
 * report) and fall back. Ask for the interpreted validators instead
 * (ADR-0035).
 *
 * This is its own module, imported first by the renderer entry: ES modules
 * run in import order, and some shared modules build schemas when they are
 * imported, which can already trigger the probe (found in Step 07: the
 * command registry's nested lease schema).
 */
config({ jitless: true });
