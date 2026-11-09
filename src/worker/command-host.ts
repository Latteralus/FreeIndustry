import { encodeBigInt } from '../shared/bigint-codec';
import type { JsonValue } from '../shared/canonical-json';
import type { ClockControl } from '../shared/ipc/clock';
import { COMMANDS, isCommandType, type InjectableFault } from '../shared/ipc/commands';
import type { QueryResult, SimulationQuery } from '../shared/ipc/facilities';
import type { ScenarioSummary } from '../shared/ipc/real-estate';
import {
  commandEnvelopeSchema,
  describeZodError,
  ipcFail,
  ipcOk,
  type CommandReceipt,
  type IpcResult,
  type SessionView,
  type WorldSnapshot,
} from '../shared/ipc/contract';
import type { CivilDate } from '../domain/time';
import type { FreeIndustryState } from '../domain/world-state';
import { DEFAULT_EPOCH, FREEINDUSTRY_RULES } from '../simulation/freeindustry-rules';
import { SimulationKernel, type WorldConfig } from '../simulation/kernel';
import { defineCommand, type SimulationRules } from '../simulation/rules';
import { companyView } from './company-view';
import { answerQuery, facilitiesView } from './facility-view';
import { realEstateView } from './real-estate-view';
import { SimulationPacer, type PacerOptions, type TickOutcome } from './pacer';

/**
 * The worker's authoritative command pipeline (spec §9.2, ADR-0013,
 * ADR-0019): the IPC-facing adapter around the simulation kernel and its
 * wall-clock pacer. Synchronous and free of threads, timers and I/O, so it
 * is unit tested directly.
 *
 * Order of checks for `submit`:
 *  1. envelope shape            → MALFORMED_REQUEST
 *  2. command type known        → UNKNOWN_COMMAND
 *  3. permission                → UNAUTHORIZED
 *  4. world instance            → STALE_REVISION
 *  then, in the kernel:
 *  5. payload schema            → INVALID_PAYLOAD
 *  6. command ID already used   → stored receipt (duplicate) or COMMAND_ID_REUSED
 *  7. world revision            → STALE_REVISION
 *  8. business rule             → COMMAND_REJECTED
 *  9. handler                   → committed, or INTERNAL_ERROR with state unchanged
 *
 * Invariant: the world revision equals the number of accepted commands, and
 * world state changes only through accepted commands and processed events.
 *
 * Loading a save replaces the whole world (`adopt`): a new world instance ID,
 * so commands prepared for the old world are refused, and a paused clock.
 */

type ThreadFault = Exclude<InjectableFault, 'handler-exception'>;

export interface CommandHostOptions {
  readonly worldInstanceId: string;
  readonly seed: number;
  readonly epoch?: CivilDate;
  /** Content the first world is built from (ADR-0037); none when omitted. */
  readonly setup?: JsonValue;
  /** The scenarios new worlds can start from, for snapshots. */
  readonly scenarios?: readonly ScenarioSummary[];
  readonly faultInjectionEnabled: boolean;
  /**
   * Carries out a thread-level fault after the command is accepted. Called
   * outside the kernel's rollback guard. `thread-exit` should not return.
   */
  readonly onThreadFault: (fault: ThreadFault) => void;
  readonly pacer: PacerOptions;
  /** Save/session state for snapshots (the worker's SaveCoordinator); null without persistence. */
  readonly session?: () => SessionView | null;
}

export interface SubmitOutcome {
  readonly result: IpcResult<CommandReceipt>;
  /** True when the world revision advanced (an event should be published). */
  readonly revised: boolean;
}

export class CommandHost {
  readonly #faultInjectionEnabled: boolean;
  readonly #onThreadFault: CommandHostOptions['onThreadFault'];
  readonly #pacerOptions: PacerOptions;
  readonly #session: () => SessionView | null;
  readonly #rules: SimulationRules<FreeIndustryState>;
  readonly #scenarios: readonly ScenarioSummary[];
  #worldInstanceId: string;
  #kernel: SimulationKernel<FreeIndustryState>;
  #pacer: SimulationPacer;
  #pendingThreadFault: ThreadFault | null = null;

  constructor(options: CommandHostOptions) {
    this.#worldInstanceId = options.worldInstanceId;
    this.#faultInjectionEnabled = options.faultInjectionEnabled;
    this.#onThreadFault = options.onThreadFault;
    this.#pacerOptions = options.pacer;
    this.#session = options.session ?? (() => null);
    this.#rules = options.faultInjectionEnabled ? this.#withFaultInjection() : FREEINDUSTRY_RULES;
    this.#scenarios = options.scenarios ?? [];
    this.#kernel = this.createWorld(
      { seed: options.seed, epoch: options.epoch ?? DEFAULT_EPOCH },
      options.setup ?? null,
    );
    this.#pacer = new SimulationPacer(this.#kernel, options.pacer);
  }

  get worldInstanceId(): string {
    return this.#worldInstanceId;
  }

  /** The rules this host runs (production rules, plus the fault hook when enabled). */
  get rules(): SimulationRules<FreeIndustryState> {
    return this.#rules;
  }

  /** The live kernel, for building save images. Callers must not mutate it. */
  get kernel(): SimulationKernel<FreeIndustryState> {
    return this.#kernel;
  }

  /** A new world under this host's rules, built from `setup` (not yet adopted). */
  createWorld(config: WorldConfig, setup: JsonValue): SimulationKernel<FreeIndustryState> {
    return SimulationKernel.create(this.#rules, config, setup);
  }

  /**
   * Replace the world with `kernel` (a new world, or a loaded or recovered
   * save) under a new world instance ID. The clock starts paused.
   */
  adopt(kernel: SimulationKernel<FreeIndustryState>, worldInstanceId: string): void {
    if (kernel.rules !== this.#rules) {
      throw new Error('A world can only be adopted if it runs under the rules of this host');
    }
    this.#kernel = kernel;
    this.#worldInstanceId = worldInstanceId;
    this.#pacer = new SimulationPacer(kernel, this.#pacerOptions);
    this.#pendingThreadFault = null;
  }

  /** The kernel fault message, if an event handler failed. */
  get fault(): string | null {
    return this.#kernel.fault?.message ?? null;
  }

  snapshot(): WorldSnapshot {
    const kernel = this.#kernel;
    const calendar = kernel.calendar();
    const pacer = this.#pacer.state;
    const next = kernel.nextEvent();
    const diagnostics = kernel.state.diagnostics;
    const fired = diagnostics.lastFiredProbe;
    return {
      worldInstanceId: this.#worldInstanceId,
      worldRevision: kernel.worldRevision,
      seed: kernel.config.seed,
      clock: {
        nowMs: encodeBigInt(kernel.nowMs),
        calendar: {
          year: calendar.year,
          month: calendar.month,
          day: calendar.day,
          weekday: calendar.weekday,
          hour: calendar.hour,
          minute: calendar.minute,
          second: calendar.second,
        },
        speed: pacer.speed,
        advance: pacer.advance && {
          until: pacer.advance.until,
          targetMs: encodeBigInt(pacer.advance.targetMs),
        },
        lastStop: pacer.lastStop && {
          until: pacer.lastStop.until,
          reason: pacer.lastStop.reason,
          atMs: encodeBigInt(pacer.lastStop.atMs),
        },
        fault: this.fault,
      },
      queue: {
        pending: kernel.pendingEventCount,
        nextEventAtMs: next ? encodeBigInt(next.timeMs) : null,
      },
      journal: { commands: kernel.journal.commandCount, events: kernel.journal.eventCount },
      fingerprint: kernel.fingerprint(),
      session: this.#session(),
      company: kernel.state.company && companyView(kernel.state.company, kernel.config.epoch),
      realEstate:
        kernel.state.realEstate &&
        realEstateView(kernel.state.realEstate, kernel.state.company, kernel.config.epoch),
      facilities:
        kernel.state.facilities &&
        facilitiesView(
          kernel.state.facilities,
          kernel.state.realEstate,
          kernel.state.company,
          kernel.config.epoch,
        ),
      scenarios: [...this.#scenarios],
      diagnostics: {
        probeCount: diagnostics.probeCount,
        lastProbeLabel: diagnostics.lastProbeLabel,
        pendingProbes: diagnostics.pendingProbes,
        firedProbes: diagnostics.firedProbes,
        lastFiredProbe: fired && {
          probeId: fired.probeId,
          label: fired.label,
          token: fired.token,
          firedAtMs: encodeBigInt(fired.firedAtMs),
        },
      },
    };
  }

  submit(raw: unknown): SubmitOutcome {
    const outcome = this.#evaluate(raw);
    const fault = this.#pendingThreadFault;
    if (fault) {
      this.#pendingThreadFault = null;
      this.#onThreadFault(fault);
    }
    return outcome;
  }

  /** A read-only question about the current world; it changes nothing (ADR-0050). */
  query(query: SimulationQuery): QueryResult {
    const { facilities, realEstate, company } = this.#kernel.state;
    return answerQuery(query, facilities, realEstate, company);
  }

  /** Clock control: pacing only, so no revision, journal entry or fingerprint change. */
  control(control: ClockControl): IpcResult<WorldSnapshot> {
    if (control.action === 'setSpeed') {
      this.#pacer.setSpeed(control.speed);
    } else {
      this.#pacer.advance(control.until);
    }
    return ipcOk(this.snapshot());
  }

  /** Called on the worker's pacing timer. */
  tick(): TickOutcome {
    return this.#pacer.tick();
  }

  #evaluate(raw: unknown): SubmitOutcome {
    const parsed = commandEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      return rejected(
        'MALFORMED_REQUEST',
        `Malformed command envelope: ${describeZodError(parsed.error)}`,
      );
    }
    const envelope = parsed.data;
    const { type } = envelope;
    if (!isCommandType(type)) {
      return rejected('UNKNOWN_COMMAND', `Unknown command type "${type}"`);
    }
    if (COMMANDS[type].permission === 'fault-injection' && !this.#faultInjectionEnabled) {
      return rejected('UNAUTHORIZED', `Command "${type}" requires fault injection to be enabled`);
    }
    if (envelope.worldInstanceId !== this.#worldInstanceId) {
      return rejected('STALE_REVISION', 'Command was prepared for a different world instance', {
        currentWorldInstanceId: this.#worldInstanceId,
        currentWorldRevision: this.#kernel.worldRevision,
      });
    }

    const result = this.#kernel.submit(envelope);
    if (!result.ok) {
      this.#pendingThreadFault = null;
      const { code, message } = result.error;
      const details =
        code === 'STALE_REVISION'
          ? { currentWorldInstanceId: this.#worldInstanceId, ...result.error.details }
          : result.error.details;
      return rejected(code, message, details);
    }
    const { receipt } = result;
    return {
      result: ipcOk({
        commandId: receipt.commandId,
        worldInstanceId: this.#worldInstanceId,
        worldRevision: receipt.worldRevision,
        atMs: encodeBigInt(receipt.atMs),
        duplicate: receipt.duplicate,
      }),
      revised: !receipt.duplicate,
    };
  }

  /**
   * Production rules plus the `diagnostics.injectFault` test hook. A
   * `handler-exception` stages real changes (an ID, a random draw, an event,
   * a state change) and then throws, proving the kernel discards them all.
   */
  #withFaultInjection(): SimulationRules<FreeIndustryState> {
    return {
      ...FREEINDUSTRY_RULES,
      commands: {
        ...FREEINDUSTRY_RULES.commands,
        'diagnostics.injectFault': defineCommand(
          COMMANDS['diagnostics.injectFault'].payload,
          (state: FreeIndustryState, { fault }, context) => {
            if (fault === 'handler-exception') {
              const probeId = context.allocateId('probe');
              const token = context.random('diagnostics').nextUint32();
              context.schedule({
                type: 'diagnostics.probeDue',
                delayMs: 1n,
                payload: { probeId, label: 'injected', scheduledAtMs: '0' },
              });
              const draft = {
                ...state.diagnostics,
                probeCount: state.diagnostics.probeCount + 1_000_000,
              };
              throw new Error(
                `Injected handler fault (draft probe count ${draft.probeCount}, token ${token})`,
              );
            }
            this.#pendingThreadFault = fault;
            return state;
          },
        ),
      },
    };
  }
}

function rejected(...args: Parameters<typeof ipcFail>): SubmitOutcome {
  return { result: ipcFail(...args), revised: false };
}
