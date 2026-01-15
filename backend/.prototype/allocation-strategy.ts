export interface IAllocationStrategy {
  pick(ids: number[]): number;
}

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
