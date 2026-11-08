import type { JsonValue } from '../shared/canonical-json';
import type { SimTimeMs } from '../domain/time';

/**
 * Deterministic priority queue of future simulation events (spec §9.1, §9.3).
 *
 * Events are ordered by `(timeMs, priority, sequence)`. `sequence` is unique
 * and increases in the order events were scheduled, so the order is total:
 * two events never compare equal, whatever the heap layout, and the same
 * schedule always pops in the same order. Lower `priority` runs first.
 */
export interface ScheduledEvent {
  /** `ev:<sequence>`, deterministic. */
  readonly id: string;
  readonly timeMs: SimTimeMs;
  readonly priority: number;
  readonly sequence: bigint;
  readonly type: string;
  /** Plain JSON, validated by the event type's schema when scheduled and when handled. */
  readonly payload: JsonValue;
}

export function eventIdFor(sequence: bigint): string {
  return `ev:${sequence}`;
}

export function compareEvents(a: ScheduledEvent, b: ScheduledEvent): number {
  if (a.timeMs !== b.timeMs) {
    return a.timeMs < b.timeMs ? -1 : 1;
  }
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (a.sequence !== b.sequence) {
    return a.sequence < b.sequence ? -1 : 1;
  }
  return 0;
}

/** Binary min-heap under {@link compareEvents}. */
export class EventQueue {
  readonly #heap: ScheduledEvent[] = [];

  static from(events: readonly ScheduledEvent[]): EventQueue {
    const queue = new EventQueue();
    for (const event of events) {
      queue.push(event);
    }
    return queue;
  }

  get size(): number {
    return this.#heap.length;
  }

  peek(): ScheduledEvent | undefined {
    return this.#heap[0];
  }

  push(event: ScheduledEvent): void {
    this.#heap.push(event);
    let index = this.#heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareEvents(this.#at(index), this.#at(parent)) >= 0) {
        break;
      }
      this.#swap(index, parent);
      index = parent;
    }
  }

  pop(): ScheduledEvent | undefined {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined || heap.length === 0) {
      return top;
    }
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && compareEvents(this.#at(left), this.#at(smallest)) < 0) {
        smallest = left;
      }
      if (right < heap.length && compareEvents(this.#at(right), this.#at(smallest)) < 0) {
        smallest = right;
      }
      if (smallest === index) {
        return top;
      }
      this.#swap(index, smallest);
      index = smallest;
    }
  }

  /** Every pending event in processing order (for fingerprints and checkpoints). */
  toSortedArray(): ScheduledEvent[] {
    return [...this.#heap].sort(compareEvents);
  }

  #at(index: number): ScheduledEvent {
    const event = this.#heap[index];
    if (event === undefined) {
      throw new RangeError(`Event heap index ${index} is out of range`);
    }
    return event;
  }

  #swap(a: number, b: number): void {
    const first = this.#at(a);
    this.#heap[a] = this.#at(b);
    this.#heap[b] = first;
  }
}
