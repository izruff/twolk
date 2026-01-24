import type { IAllocationStrategy } from "./allocation-strategy.ts";


/** Registered signaling server endpoint. */
interface ServerEntry {
  id: number;
  url: string;
}

/**
 * Coordinator-side subservice that assigns signaling servers to preflight
 * requests for joining a space.
 *
 * This class keeps track of available signaling servers through observers
 * which the coordinator attaches to the bus.
 */
export class ChannelPreAllocator {
  private _servers: ServerEntry[] = [];
  private _strategy: IAllocationStrategy;

  constructor(strategy: IAllocationStrategy) {
    this._strategy = strategy;
  }

  onServerConnected(serverId: number, serverUrl: string): void {
    // TODO: Reject or replace duplicate server IDs instead of appending them.
    this._servers.push({ id: serverId, url: serverUrl });
  }

  onServerDisconnected(serverId: number): void {
    this._servers = this._servers.filter((s) => s.id !== serverId);
  }

  /** Returns the URL of the selected signaling server. */
  allocate(): string {
    const ids = this._servers.map((s) => s.id);
    const chosen = this._strategy.pick(ids);
    // TODO: Validate strategy output instead of assuming it came from `ids`.
    return this._servers.find((s) => s.id === chosen)!.url;
  }

  /** Number of signaling servers currently available for allocation. */
  get serverCount(): number {
    return this._servers.length;
  }
}
