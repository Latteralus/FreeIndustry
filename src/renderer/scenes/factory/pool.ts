/**
 * A free list of reusable display objects (spec §11.3 "pooling"): sprites,
 * graphics and labels are taken from it and given back instead of being
 * created and destroyed as objects come and go. Generic and pure, so its
 * accounting is tested without a GPU.
 */
export class Pool<T> {
  readonly #create: () => T;
  readonly #reset: (item: T) => void;
  readonly #free: T[] = [];
  #created = 0;

  constructor(create: () => T, reset: (item: T) => void) {
    this.#create = create;
    this.#reset = reset;
  }

  acquire(): T {
    const item = this.#free.pop();
    if (item !== undefined) {
      return item;
    }
    this.#created += 1;
    return this.#create();
  }

  release(item: T): void {
    this.#reset(item);
    this.#free.push(item);
  }

  /** Items waiting to be reused. */
  get free(): number {
    return this.#free.length;
  }

  /** Items ever created. Steady scenes stop creating. */
  get created(): number {
    return this.#created;
  }

  /** Hand every free item to `destroy` and forget them. */
  drain(destroy: (item: T) => void): void {
    for (const item of this.#free.splice(0)) {
      destroy(item);
    }
  }
}
