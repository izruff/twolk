/*

Allocation strategy abstraction and server selection for new client channels.

IAllocationStrategy is a generic "pick one from a list of IDs" contract
used by both ChannelPreAllocator (signaling servers) and RouterAllocator
(media workers).

*/


// Generic allocation strategy: given a list of numeric IDs, return the
// one selected for the next allocation.
export interface IAllocationStrategy {
  pick(ids: number[]): number;
}

// Stateful round-robin: cycles through IDs in the order they were passed,
// wrapping around when the end is reached.
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


interface ServerEntry {
  id: number;
  url: string;
}

export class ChannelPreAllocator {
  private _servers: ServerEntry[] = [];
  private _strategy: IAllocationStrategy;

  constructor(strategy: IAllocationStrategy) {
    this._strategy = strategy;
  }

  onServerConnected(serverId: number, serverUrl: string): void {
    this._servers.push({ id: serverId, url: serverUrl });
  }

  onServerDisconnected(serverId: number): void {
    this._servers = this._servers.filter((s) => s.id !== serverId);
  }

  // Returns the URL of the chosen server. Throws if no servers are available.
  allocate(): string {
    const ids = this._servers.map((s) => s.id);
    const chosen = this._strategy.pick(ids);
    return this._servers.find((s) => s.id === chosen)!.url;
  }

  get serverCount(): number {
    return this._servers.length;
  }
}
