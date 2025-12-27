/*

In-process counter id generator. Each instance has its own counter, so
two generators handed to different services produce independent
sequences. Wraps at MAX_SAFE_INTEGER.

*/

import type { IIdGenerator } from "./id-gen-port.ts";


export class ProcessCounterIdGenerator implements IIdGenerator {
  // These should be okay because these resources are not permanent and
  // the traffic should not exceed this maximum limit.
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER

  counter: number = 0

  next(): number {
    const id = this.counter;
    this.counter = (this.counter + 1) % ProcessCounterIdGenerator.MAX_COUNTER;
    return id;
  }
}
