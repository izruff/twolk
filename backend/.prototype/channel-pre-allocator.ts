/*

Server selection for new client channels.

ChannelPreAllocator keeps track of connected signaling servers and uses
an IServerAllocationStrategy to pick one when a new channel is requested.
The strategy is injected so it can be swapped for testing or future
load-aware variants.

*/


export interface IServerAllocationStrategy {
  pick(serverIds: number[]): number;
}

// Stateful round-robin: cycles through server IDs in the order they
// were passed, wrapping around when the end is reached.
export class RoundRobinServerStrategy implements IServerAllocationStrategy {
  private _counter = 0;

  pick(serverIds: number[]): number {
    if (serverIds.length === 0) {
      throw new Error("no signaling servers available");
    }
    const idx = this._counter % serverIds.length;
    this._counter++;
    return serverIds[idx];
  }
}


interface ServerEntry {
  id: number;
  url: string;
}

export class ChannelPreAllocator {
  private _servers: ServerEntry[] = [];
  private _strategy: IServerAllocationStrategy;

  constructor(strategy: IServerAllocationStrategy) {
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
