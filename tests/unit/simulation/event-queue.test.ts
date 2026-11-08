import fc from 'fast-check';
import {
  compareEvents,
  EventQueue,
  eventIdFor,
  type ScheduledEvent,
} from '../../../src/simulation/event-queue';

function event(sequence: number, timeMs: number, priority: number): ScheduledEvent {
  const seq = BigInt(sequence);
  return {
    id: eventIdFor(seq),
    timeMs: BigInt(timeMs),
    priority,
    sequence: seq,
    type: 'test',
    payload: null,
  };
}

const schedule = fc
  .array(
    fc.record({ time: fc.integer({ min: 0, max: 20 }), priority: fc.constantFrom(100, 200, 900) }),
    { maxLength: 200 },
  )
  .map((items) => items.map((item, index) => event(index + 1, item.time, item.priority)));

describe('EventQueue', () => {
  it('orders by time, then priority, then scheduling sequence', () => {
    const queue = EventQueue.from([
      event(1, 10, 200),
      event(2, 10, 100),
      event(3, 5, 900),
      event(4, 10, 100),
    ]);
    expect([queue.pop(), queue.pop(), queue.pop(), queue.pop()].map((item) => item?.id)).toEqual([
      'ev:3',
      'ev:2',
      'ev:4',
      'ev:1',
    ]);
    expect(queue.pop()).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it('property: pops in exactly the order of a stable sort, whatever the insertion order', () => {
    fc.assert(
      fc.property(
        schedule.chain((events) =>
          fc.tuple(fc.constant(events), fc.shuffledSubarray(events, { minLength: events.length })),
        ),
        ([events, shuffled]) => {
          const queue = EventQueue.from(shuffled);
          const popped: string[] = [];
          for (let next = queue.pop(); next; next = queue.pop()) {
            popped.push(next.id);
          }
          expect(popped).toEqual([...events].sort(compareEvents).map((item) => item.id));
        },
      ),
    );
  });

  it('property: interleaved pushes and pops always yield the minimum', () => {
    fc.assert(
      fc.property(schedule, fc.array(fc.boolean(), { maxLength: 400 }), (events, ops) => {
        const queue = new EventQueue();
        const model: ScheduledEvent[] = [];
        let next = 0;
        for (const push of ops) {
          const candidate = events[next];
          if (push && candidate) {
            queue.push(candidate);
            model.push(candidate);
            next += 1;
          } else {
            model.sort(compareEvents);
            expect(queue.pop()?.id).toBe(model.shift()?.id);
          }
          expect(queue.size).toBe(model.length);
          expect(queue.peek()?.id).toBe([...model].sort(compareEvents)[0]?.id);
        }
      }),
    );
  });

  it('lists pending events in processing order without consuming them', () => {
    const queue = EventQueue.from([event(1, 3, 100), event(2, 1, 100)]);
    expect(queue.toSortedArray().map((item) => item.id)).toEqual(['ev:2', 'ev:1']);
    expect(queue.size).toBe(2);
  });
});
