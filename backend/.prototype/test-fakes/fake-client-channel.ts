/*

In-memory fake of IClientChannel and IClientChannelAcceptor. Lets tests
push messages "from the client" via `simulateClientEmit`, observe what
the server emitted via `emitted`, and close the channel via
`simulateClose`.

The acceptor lets tests inject channels with `inject(channel)`, then
flips into "no longer accepting" after `stop()`.

*/

import type {
  IClientChannel, IClientChannelAcceptor, EventMap,
  EventArgs, EventHandlerFor,
} from "../client-channel-port.ts";


export interface EmittedMessage {
  event: string;
  args: any[];
}


let _channelIdCounter = 0;


export class FakeClientChannel<C2S extends EventMap, S2C extends EventMap>
  implements IClientChannel<C2S, S2C> {
  id: string = "fake-channel-" + (_channelIdCounter++).toString(36)
  auth: unknown

  // Test-visible state: every emit() lands here in order.
  emitted: EmittedMessage[] = []

  // Registered handlers by event name.
  _handlers: Map<string, Array<(...args: any[]) => any>> = new Map()
  _closeHandlers: Array<() => void> = []

  _closed: boolean = false

  constructor(auth: unknown = {}) {
    this.auth = auth;
  }

  on<K extends keyof C2S>(event: K, handler: EventHandlerFor<C2S, K>): void {
    const name = event as string;
    if (!this._handlers.has(name)) {
      this._handlers.set(name, []);
    }
    this._handlers.get(name)!.push(handler as any);
  }

  off<K extends keyof C2S>(event: K, handler: EventHandlerFor<C2S, K>): void {
    const name = event as string;
    const handlers = this._handlers.get(name);
    if (handlers === undefined) return;
    this._handlers.set(name, handlers.filter((h) => h !== handler));
  }

  emit<K extends keyof S2C>(event: K, ...args: EventArgs<S2C, K>): void {
    if (this._closed) return;
    this.emitted.push({ event: event as string, args: args as any[] });
  }

  onClose(handler: () => void): void {
    this._closeHandlers.push(handler);
  }

  close(): void {
    this.simulateClose();
  }

  // Test helpers ----------------------------------------------------------

  // Pretend the client emitted `event` with these args.
  simulateClientEmit<K extends keyof C2S>(event: K, ...args: EventArgs<C2S, K>): void {
    const handlers = this._handlers.get(event as string);
    if (handlers === undefined) return;
    for (const h of [...handlers]) {
      h(...args);
    }
  }

  // Pretend the connection dropped.
  simulateClose(): void {
    if (this._closed) return;
    this._closed = true;
    for (const h of [...this._closeHandlers]) {
      h();
    }
  }

  // Last emitted message of a specific event name.
  lastEmitted(event: string): EmittedMessage | undefined {
    for (let i = this.emitted.length - 1; i >= 0; i--) {
      if (this.emitted[i].event === event) return this.emitted[i];
    }
    return undefined;
  }
}


export class FakeClientChannelAcceptor<C2S extends EventMap, S2C extends EventMap>
  implements IClientChannelAcceptor<C2S, S2C> {
  _handler: ((channel: IClientChannel<C2S, S2C>) => void) | null = null
  _started: boolean = false
  _stopped: boolean = false

  onChannel(handler: (channel: IClientChannel<C2S, S2C>) => void): void {
    this._handler = handler;
  }

  start(): void {
    this._started = true;
  }

  stop(): void {
    this._stopped = true;
  }

  // Test helper — push a new channel as if it just connected.
  inject(channel: FakeClientChannel<C2S, S2C>): void {
    if (!this._started || this._stopped) return;
    this._handler?.(channel);
  }
}
