/*

Client-channel port. Wraps a single bi-directional connection with a
client (browser, native app, future variant) behind an interface that
matches what the signaling server actually does to it: typed emit,
typed on/off for incoming messages, an auth blob, and lifecycle.

The acceptor port is the producer side — it hands fresh channels to
whoever registers via `onChannel(handler)`.

Today the only adapter is `SocketIoChannel` / `SocketIoChannelAcceptor`.
A FakeChannel for tests has the same shape and skips the network.

*/

export type EventMap = Record<string, (...args: any[]) => any>;


export interface IClientChannel<C2S extends EventMap, S2C extends EventMap> {
  readonly id: string;
  // Auth blob the client supplied on connect. Treated as opaque here;
  // each caller knows what shape to expect.
  readonly auth: unknown;

  on<K extends keyof C2S>(event: K, handler: C2S[K]): void;
  off<K extends keyof C2S>(event: K, handler: C2S[K]): void;

  emit<K extends keyof S2C>(event: K, ...args: Parameters<S2C[K]>): void;

  // Lifecycle. `onClose` fires when the underlying connection is gone
  // (either side). `close` actively terminates it.
  onClose(handler: () => void): void;
  close(): void;
}


export interface IClientChannelAcceptor<C2S extends EventMap, S2C extends EventMap> {
  // Registers a handler called once per incoming channel. Only one
  // handler is supported; later calls overwrite.
  onChannel(handler: (channel: IClientChannel<C2S, S2C>) => void): void;

  start(): void;
  stop(): void;
}
