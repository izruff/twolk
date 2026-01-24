import type { IIdGenerator } from "./id-gen-port.ts";


/**
 * Single-threaded incremental counter for temporary resources.
 *
 * Note that this counter wraps to zero after reaching an upper limit.
 * This limit is quite high and it is expected that an ID is never used for
 * two active resources at the same time. However, there is currently no
 * mechanism to alert when this happens.
 *
 * TODO: The coordinator should enforce a resource limit mechanism, which
 * will also interact with these ID generators.
 */
export class ProcessCounterIdGenerator implements IIdGenerator {
  /** The maximum limit of `counter` before it wraps to zero. */
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER

  counter: number = 0

  next(): number {
    const id = this.counter;
    this.counter = (this.counter + 1) % ProcessCounterIdGenerator.MAX_COUNTER;
    return id;
  }
}
