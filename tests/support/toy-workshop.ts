import { z } from 'zod';
import { reject } from '../../src/domain/rejection';
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '../../src/domain/time';
import { defineCommand, defineEvent, type SimulationRules } from '../../src/simulation/rules';

/**
 * TEST FIXTURE — not FreeIndustry game rules. A deliberately busy toy world
 * that exercises everything the kernel offers: high-frequency physical
 * events with random durations, periodic economic and management decisions
 * on separate lanes and cadences, seeded random streams, deterministic IDs,
 * facts, commands that reject, a notable event and a conservation
 * invariant (delivered = inbound + shelf + shipped).
 */

interface ToyWorker {
  readonly id: string;
  readonly name: string;
  readonly moved: number;
}

export interface ToyState {
  readonly workers: readonly ToyWorker[];
  readonly delivered: number;
  readonly inbound: number;
  readonly shelf: number;
  readonly shipped: number;
  readonly priceCents: number;
  readonly marketRounds: number;
  readonly reviews: number;
  readonly alarms: number;
  /** Order in which lanes acted at shared instants, for ordering tests. */
  readonly laneTrace: readonly string[];
}

const workerSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  moved: z.int().min(0),
});

const stateSchema = z.strictObject({
  workers: z.array(workerSchema),
  delivered: z.int().min(0),
  inbound: z.int().min(0),
  shelf: z.int().min(0),
  shipped: z.int().min(0),
  priceCents: z.int(),
  marketRounds: z.int().min(0),
  reviews: z.int().min(0),
  alarms: z.int().min(0),
  laneTrace: z.array(z.string()),
});

const TRACE_LIMIT = 12;
const trace = (state: ToyState, entry: string): readonly string[] =>
  [...state.laneTrace, entry].slice(-TRACE_LIMIT);

const MOVE_MIN_MS = 2 * Number(MS_PER_SECOND);
const MOVE_MAX_MS = 9 * Number(MS_PER_SECOND);
const IDLE_RETRY_MS = MS_PER_MINUTE;

export const TOY_WORKSHOP: SimulationRules<ToyState> = {
  id: 'test-toy-workshop',
  version: 1,
  initialState: (context) => ({
    workers: [],
    delivered: 0,
    inbound: 0,
    shelf: 0,
    shipped: 0,
    priceCents: 1_000 + context.random('market').nextBelow(500),
    marketRounds: 0,
    reviews: 0,
    alarms: 0,
    laneTrace: [],
  }),
  encodeState: (state) => ({ ...state, workers: state.workers.map((worker) => ({ ...worker })) }),
  decodeState: (json) => stateSchema.parse(json),
  checkInvariants: (state) =>
    state.inbound + state.shelf + state.shipped === state.delivered
      ? []
      : [`stock not conserved: ${JSON.stringify(state)}`],
  commands: {
    'toy.hire': defineCommand(
      z.strictObject({ name: z.string().min(1).max(40) }),
      (state: ToyState, { name }, context) => {
        if (state.workers.length >= 8) {
          return reject('The toy workshop has room for eight workers');
        }
        const id = context.allocateId('worker');
        const delay = context.random('labour').nextIntInclusive(MOVE_MIN_MS, MOVE_MAX_MS);
        context.schedule({
          type: 'toy.moveDone',
          delayMs: BigInt(delay),
          payload: { workerId: id },
        });
        context.record('toy.hired', { id, name });
        return { ...state, workers: [...state.workers, { id, name, moved: 0 }] };
      },
    ),
    'toy.deliver': defineCommand(
      z.strictObject({ quantity: z.int().min(1).max(10_000) }),
      (state: ToyState, { quantity }) => ({
        ...state,
        delivered: state.delivered + quantity,
        inbound: state.inbound + quantity,
      }),
    ),
    'toy.setAlarm': defineCommand(
      z.strictObject({ delayMs: z.int().min(0).max(86_400_000) }),
      (state: ToyState, { delayMs }, context) => {
        context.schedule({ type: 'toy.alarm', delayMs: BigInt(delayMs), payload: {} });
        return state;
      },
    ),
    'toy.explode': defineCommand(z.strictObject({}), (_state: ToyState, _payload, context) => {
      context.allocateId('worker');
      context.random('labour').nextUint32();
      context.schedule({ type: 'toy.alarm', delayMs: 0n, payload: {} });
      context.record('toy.boom', null);
      throw new Error('toy handler failure');
    }),
    'toy.scheduleBroken': defineCommand(
      z.strictObject({}),
      (state: ToyState, _payload, context) => {
        context.schedule({ type: 'toy.broken', delayMs: MS_PER_MINUTE, payload: {} });
        return state;
      },
    ),
  },
  events: {
    'toy.moveDone': defineEvent({
      lane: 'physical',
      payload: z.strictObject({ workerId: z.string() }),
      handle: (state: ToyState, { workerId }, context) => {
        if (state.inbound === 0) {
          context.schedule({ type: 'toy.moveDone', delayMs: IDLE_RETRY_MS, payload: { workerId } });
          return { ...state, laneTrace: trace(state, `physical:idle:${workerId}`) };
        }
        const delay = context.random('labour').nextIntInclusive(MOVE_MIN_MS, MOVE_MAX_MS);
        context.schedule({ type: 'toy.moveDone', delayMs: BigInt(delay), payload: { workerId } });
        return {
          ...state,
          inbound: state.inbound - 1,
          shelf: state.shelf + 1,
          workers: state.workers.map((worker) =>
            worker.id === workerId ? { ...worker, moved: worker.moved + 1 } : worker,
          ),
          laneTrace: trace(state, `physical:${workerId}`),
        };
      },
    }),
    'toy.alarm': defineEvent({
      lane: 'management',
      notable: true,
      payload: z.strictObject({}),
      handle: (state: ToyState) => ({ ...state, alarms: state.alarms + 1 }),
    }),
    'toy.broken': defineEvent({
      lane: 'physical',
      payload: z.strictObject({}),
      handle: (_state: ToyState): ToyState => {
        throw new Error('toy event failure');
      },
    }),
  },
  periodic: {
    'toy.market': {
      lane: 'economic',
      periodMs: 15n * MS_PER_MINUTE,
      phaseMs: 0n,
      handle: (state, context) => {
        const market = context.random('market');
        const priceCents = Math.max(100, state.priceCents + market.nextIntInclusive(-50, 50));
        const demand = market.nextBelow(4);
        const sold = Math.min(demand, state.shelf);
        if (sold > 0) {
          context.record('toy.sold', { sold, priceCents });
        }
        return {
          ...state,
          priceCents,
          shelf: state.shelf - sold,
          shipped: state.shipped + sold,
          marketRounds: state.marketRounds + 1,
          laneTrace: trace(state, 'economic'),
        };
      },
    },
    'toy.review': {
      lane: 'management',
      periodMs: MS_PER_HOUR,
      phaseMs: 0n,
      handle: (state, context) => {
        const restock = state.inbound < 5 && context.random('supplier').chance(1, 2);
        const quantity = restock ? context.random('supplier').nextIntInclusive(1, 12) : 0;
        return {
          ...state,
          delivered: state.delivered + quantity,
          inbound: state.inbound + quantity,
          reviews: state.reviews + 1,
          laneTrace: trace(state, 'management'),
        };
      },
    },
  },
};

/** Deterministic UUIDs for scripted commands. */
export function testUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
