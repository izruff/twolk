/**
 * Resource-agnostic allocation strategies shared by prototype allocators.
 */
export interface IAllocationStrategy {
  /** Selects one candidate ID, or throws when no candidate is usable. */
  pick(ids: number[]): number;
}

/**
 * Stateful round-robin allocation strategy.
 *
 * The strategy advances once per successful pick and wraps through the
 * candidate order supplied by the caller. The counter is process-local and is
 * not reset when the candidate list changes.
 *
 * TODO: Decide whether empty-candidate validation belongs in callers so all
 * strategies share the same failure behavior.
 */
export class RoundRobinStrategy implements IAllocationStrategy {
  private _counter = 0;

  pick(ids: number[]): number {
    if (ids.length === 0) {
      throw new Error("no items available for allocation");
    }
    const idx = this._counter % ids.length;
    this._counter++;
    return ids[idx];
  }
}
