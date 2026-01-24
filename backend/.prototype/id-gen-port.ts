/**
 * Stateful numeric ID generator port.
 */
export interface IIdGenerator {
  /** Returns the next ID, unique within the generator's scope. */
  next(): number;
}
