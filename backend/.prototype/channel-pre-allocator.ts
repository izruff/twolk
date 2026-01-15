import type { IAllocationStrategy } from "./allocation-strategy.ts";


/*

Allocation strategy abstraction and server selection for new client channels.

IAllocationStrategy is a generic "pick one from a list of IDs" contract
used by both ChannelPreAllocator (signaling servers) and RouterAllocator
(media workers).

*/


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
